/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * E2E: pause must actually pause (desktop).
 *
 * Two families of bug are guarded here.
 *
 * 1) REACHABILITY. The transport bar (timeline + pause + volume) used to be laid
 *    out BELOW the window: the player chain measured its height from the
 *    <video>'s intrinsic ratio, `body` has overflow:hidden, so Pause was
 *    literally unclickable at any ordinary window size. The right-hand button
 *    group also ran past the right edge (fullscreen/PiP unreachable), and the
 *    secondary windows' backdrop swallowed clicks on the whole top bar. Every
 *    case below asserts both geometry AND an elementFromPoint hit test, because
 *    a bounding box alone does not prove a click reaches the control.
 *
 * 2) TRANSPORT SEMANTICS on the ffmpeg/MSE tier. A seek outside the decoded
 *    buffer restarts the pipeline and DETACHES the element for a moment, so
 *    `el.paused` is true and `el.src` is empty while it reboots. Decisions made
 *    from those transient values broke:
 *      - pause pressed mid-restart was swallowed (el.pause() on a detached
 *        element is a no-op) and the restart's autoplay resumed playback;
 *      - play pressed mid-restart took the "element has no source, reload it"
 *        path and restarted the whole decode from 0.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ffmpeg = require('ffmpeg-static');
const electron = require('electron');
// A UNIQUE port and profile per run. The app takes a single-instance lock,
// so two harnesses sharing a profile make the second one adopt the first
// one's still-shutting-down instance: the page under test is then the WRONG
// process, with different media loaded, which looks exactly like a flaky app.
const CDP_PORT = 9400 + (process.pid % 500);
/** Unique-per-run Electron profile (see the CDP_PORT note above). */
function profileDir() {
  return path.join(os.tmpdir(), `movira-test-profile-${path.basename(__filename, '.cjs')}-${process.pid}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-pause-'));
function gen(file, args) {
  const out = path.join(tmp, file);
  const argv = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const a of args) {
    if (typeof a === 'string' && a.startsWith('-i')) argv.push('-f', 'lavfi');
    argv.push(a);
  }
  execFileSync(ffmpeg, [...argv, out], { timeout: 180000 });
  return out;
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        this.logs.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text || 'exception');
      }
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      setTimeout(() => reject(new Error('CDP timeout: ' + method)), 150000);
    });
  }
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Renderer exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

/** Dispatch a real key sequence on document.body so document- and
 *  window-level listeners both see it (see the other suites). */
function keyExpr(key) {
  return `(() => {
    const opts = { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true };
    document.body.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.body.dispatchEvent(new KeyboardEvent('keyup', opts));
  })()`;
}

/** Click the transport play/pause button exactly like a user would. */
const clickPlayBtn = `(() => { const b = document.querySelector('.play-btn'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`;

/**
 * Reachability audit for a container: every visible control must be inside the
 * window AND must be the topmost element at its own centre (nothing covering
 * it). Returns the offenders so a failure names the real control.
 */
const AUDIT = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const rep = (name, sel) => {
    const root = document.querySelector(sel);
    if (!root) return { name, missing: true };
    const bad = [];
    let total = 0;
    root.querySelectorAll('button, input, select, [role=button]').forEach((b) => {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      total++;
      const tag = (b.getAttribute('title') || b.textContent || b.tagName).trim().slice(0, 22);
      if (r.top < 0 || r.bottom > vh || r.left < 0 || r.right > vw) { bad.push('offscreen:' + tag); return; }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !(hit.closest && hit.closest('button, input, select, [role=button]'))) {
        bad.push('covered:' + tag + '<-' + (hit ? hit.tagName + '.' + String(hit.className || '').slice(0, 18) : 'null'));
      }
    });
    return { name, total, bad };
  };
  return JSON.stringify({
    viewport: [vw, vh],
    transport: rep('transport', '.transport'),
    topbar: rep('topbar', '.topbar'),
    panel: rep('floating-panel', '.floating-panel'),
  });
})()`;

const state = () => `(() => {
  const v = document.querySelector('video');
  const s = window.__moviraServices;
  if (!v || !s) return JSON.stringify({ none: true });
  const btn = document.querySelector('.play-btn');
  return JSON.stringify({
    paused: v.paused,
    rs: v.readyState,
    err: v.error ? v.error.code : null,
    src: v.currentSrc ? v.currentSrc.slice(0, 12) : '',
    ft: +s.engine.currentFileTime().toFixed(2),
    busy: s.engine.isFallbackBusy(),
    label: btn ? btn.textContent : '',
    dur: isFinite(v.duration) ? +v.duration.toFixed(2) : null,
  });
})()`;

async function snap(cdp) { return JSON.parse(await evalJs(cdp, state())); }
async function audit(cdp) { return JSON.parse(await evalJs(cdp, AUDIT)); }

/** Wait until the element is playing (frames flowing, not paused). */
async function waitPlaying(cdp, timeoutMs = 25000) {
  for (let i = 0; i * 250 < timeoutMs; i++) {
    await sleep(250);
    const s = await snap(cdp);
    if (!s.none && !s.paused && s.rs >= 3 && s.err === null) return s;
  }
  return null;
}

/** Wait until the element is paused with no error. */
async function waitPaused(cdp, timeoutMs = 15000) {
  for (let i = 0; i * 250 < timeoutMs; i++) {
    await sleep(250);
    const s = await snap(cdp);
    if (!s.none && s.paused && s.err === null) return s;
  }
  return null;
}

/**
 * Fire a REAL transport-button click while a tier-2 seek-restart is in flight.
 *
 * A seek only restarts the pipeline when the target is outside what the current
 * stream has decoded, so the target comes from the live buffer
 * (bufferedEnd + 60s) — guaranteed to need a restart. engine.seek() detaches
 * the element synchronously, so clicking from the very next task lands inside
 * the restart window, which is then VERIFIED (not assumed) before clicking.
 */
async function seekAndClickInRestart(cdp) {
  const raw = await evalJs(cdp, `(async () => {
    const s = window.__moviraServices;
    const v = document.querySelector('video');
    const btn = document.querySelector('.play-btn');
    const b = v.buffered;
    const beEl = b.length ? b.end(b.length - 1) : 0;
    // Element time != file time after a restart (the muxer rebases timestamps),
    // so derive the buffer end in FILE time before picking a target: seeking
    // to raw element time would land inside the buffer and never restart.
    const fileBufEnd = s.engine.currentFileTime() + (beEl - v.currentTime);
    const before = window.__moviraMseDebug;
    const target = fileBufEnd + 60;
    const labels = [];
    const iv = setInterval(() => labels.push(btn.textContent), 40);
    await s.engine.seek(target);
    const rebuilding = !v.currentSrc || v.buffered.length === 0 || window.__moviraMseDebug !== before;
    // Snapshot the button BEFORE the click: while the pipeline rebuilds, the
    // glyph must keep showing the state the user is in.
    const labelBefore = labels.join('');
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    clearInterval(iv);
    return JSON.stringify({ target: +target.toFixed(1), bufferedEnd: +fileBufEnd.toFixed(1), rebuilding, labels: labels.join(''), labelBefore });
  })()`);
  return JSON.parse(raw);
}

/** Wait for the pipeline to settle (element attached again) and then some. */
async function settle(cdp, extraMs = 2500) {
  for (let i = 0; i * 250 < 40000; i++) {
    await sleep(250);
    const s = await snap(cdp);
    if (!s.none && s.src && s.err === null && s.rs >= 3) break;
  }
  await sleep(extraMs);
}

async function playPath(cdp, p, label) {
  await evalJs(cdp, `(async () => {
    window.__moviraTestPlay([{ id: 'pause-${label}', type: 'video', title: '${label}', path: ${JSON.stringify(p)} }], 0);
    return 'ok';
  })()`);
  return !!(await waitPlaying(cdp));
}

/** Click through the real hit-test path: dispatch on whatever is on top at the
 *  control's own coordinates — a plain .click() on the node would hide layout
 *  and overlay problems that make the control dead for a real user. */
async function clickAtCentre(cdp, selector) {
  return evalJs(cdp, `(() => {
    const b = document.querySelector(${JSON.stringify(selector)});
    if (!b) return 'missing';
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit) return 'offscreen';
    for (const type of ['mousedown', 'mouseup', 'click']) {
      hit.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
    return hit.closest(${JSON.stringify(selector)}) ? 'hit' : 'blocked:' + hit.tagName + '.' + String(hit.className || '').slice(0, 24);
  })()`);
}

async function main() {
  console.log('Generating media (400s ts = tier 2, 120s mp4 = tier 1, muted)...');
  // 400s at 640x480 on purpose: MSE appends run far faster than realtime, so a
  // short clip buffers COMPLETELY within a second and every seek lands inside
  // the buffer (no decoder restart at all). A long clip keeps a real
  // unbuffered region to seek into, which the mid-restart cases need.
  const V = ['testsrc=size=640x480:rate=25:duration=400', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50'];
  const A = ['-c:a', 'aac', '-b:a', '96k'];
  const ts = gen('clip.ts', ['-i', V[0], '-i', 'sine=frequency=440:duration=400,volume=0', V[1], V[2], V[3], V[4], ...A, '-f', 'mpegts']);
  const V1 = ['testsrc=size=320x240:rate=25:duration=120', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50'];
  const mp4 = gen('clip.mp4', ['-i', V1[0], '-i', 'sine=frequency=480:duration=120,volume=0', V1[1], V1[2], V1[3], V1[4], ...A, '-f', 'mp4']);

  console.log('Launching Electron app...');
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, MOVIRA_USER_DATA_DIR: profileDir() },
    stdio: 'ignore', windowsHide: true,
  });

  try {
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      await sleep(1000);
      try {
        const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        page = list.find((t) => t.type === 'page' && /dist[\\/]renderer[\\/]index\.html/.test(t.url));
      } catch { /* retry */ }
    }
    if (!page) throw new Error('app page not found');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);

    // The renderer installs its test hook after services resolve; several
    // earlier runs raced it and died on "__moviraTestPlay is not a function".
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await sleep(500);
      ready = await evalJs(cdp, `!!(window.__moviraTestPlay && window.__moviraServices)`).catch(() => false);
    }
    if (!ready) throw new Error('renderer never became ready');

    // ------------------------------------------------------------------
    console.log('\n== Reachability: every transport control is clickable ==');
    ok('mp4 (tier 1) opens and plays', await playPath(cdp, mp4, 'mp4'));
    {
      // Right after a file opens, an MSE element reports duration=Infinity
      // until the muxer declares one. The timeline rejected the whole gesture
      // in that window, so the very first drag/click a user makes did nothing.
      const early = JSON.parse(await evalJs(cdp, `(async () => {
        const tl = document.querySelector('.timeline');
        const eng = window.__moviraServices.engine;
        const v = document.querySelector('video');
        const max = tl.getAttribute('aria-valuemax');
        const total = Number(max);
        const r = tl.getBoundingClientRect();
        const want = 0.5 * (isFinite(total) && total > 0 ? total : 0);
        const x = r.left + r.width * 0.5, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        const node = hit && hit.closest && hit.closest('.timeline') ? hit : tl;
        node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 71, pointerType: 'mouse', button: 0, isPrimary: true }));
        node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 71, pointerType: 'mouse', button: 0, isPrimary: true }));
        let landed = null;
        for (let i = 0; i < 60; i++) {
          await new Promise((z) => setTimeout(z, 150));
          const ft = eng.currentFileTime();
          if (Math.abs(ft - want) < 2) { landed = +ft.toFixed(1); break; }
        }
        return JSON.stringify({ max, elDur: String(v.duration), want: +want.toFixed(1), landed, hit: hit ? String(hit.className) : 'null' });
      })()`));
      ok('timeline duration is never Infinity once playback starts', isFinite(Number(early.max)) && Number(early.max) > 0, JSON.stringify(early));
      ok('timeline click works immediately after opening a file', early.landed !== null, JSON.stringify(early));
      await playPath(cdp, mp4, 'mp4re');
    }
    {
      const a = await audit(cdp);
      ok('transport: no dead controls', a.transport.total > 8 && a.transport.bad.length === 0, JSON.stringify(a.transport));
      ok('top bar: no dead controls', a.topbar.bad.length === 0, JSON.stringify(a.topbar));
      // The real click path: hit-test at the button's own coordinates.
      const res = await clickAtCentre(cdp, '.play-btn');
      await sleep(900);
      const paused = await snap(cdp);
      ok('coordinate click on Play/Pause pauses (was off-screen before)', res === 'hit' && paused.paused === true, `${res} ${JSON.stringify(paused)}`);
      const res2 = await clickAtCentre(cdp, '.play-btn');
      const resumed = await waitPlaying(cdp, 8000);
      ok('coordinate click on Play/Pause resumes', res2 === 'hit' && !!resumed, `${res2} ${JSON.stringify(resumed)}`);
      // The fullscreen control lives at the far right of that row.
      const fsRes = await clickAtCentre(cdp, '.transport button[title^="Fullscreen"]');
      ok('fullscreen button is reachable by coordinates', fsRes === 'hit', fsRes);
      await sleep(1500);
      const inFs = JSON.parse(await evalJs(cdp, `JSON.stringify({ w: innerWidth, fs: !!document.querySelector('.player-view.fullscreen') })`));
      ok('fullscreen actually engaged', inFs.fs === true, JSON.stringify(inFs));
      const aFs = await audit(cdp);
      ok('transport reachable in fullscreen', aFs.transport.bad.length === 0, JSON.stringify(aFs.transport));
      // Pause must work in fullscreen too (that is where a missing control hurts).
      const fsPause = await clickAtCentre(cdp, '.play-btn');
      await sleep(900);
      const fsPaused = await snap(cdp);
      ok('pause works in fullscreen', fsPause === 'hit' && fsPaused.paused === true, `${fsPause} ${JSON.stringify(fsPaused)}`);
      await clickAtCentre(cdp, '.play-btn');
      await evalJs(cdp, keyExpr('Escape'));
      await sleep(1500);
      ok('Escape left fullscreen', JSON.parse(await evalJs(cdp, `JSON.stringify({ fs: !!document.querySelector('.player-view.fullscreen') })`)).fs === false);
    }

    // ------------------------------------------------------------------
    console.log('\n== Reachability with a secondary window open ==');
    {
      await evalJs(cdp, `(() => { document.querySelectorAll('.topbar .btn.topbar-nav')[1].click(); return 1; })()`);
      await sleep(700);
      const a = await audit(cdp);
      ok('library panel: no dead controls', a.panel.total > 0 && a.panel.bad.length === 0, JSON.stringify(a.panel));
      ok('transport still clickable while a panel floats above it', a.transport.bad.length === 0, JSON.stringify(a.transport));
      ok('top bar still clickable while a panel floats above it', a.topbar.bad.length === 0, JSON.stringify(a.topbar));
      const hit = await clickAtCentre(cdp, '.play-btn');
      await sleep(900);
      const p = await snap(cdp);
      ok('pause works while a secondary window is open', hit === 'hit' && p.paused === true, `${hit} ${JSON.stringify(p)}`);
      await clickAtCentre(cdp, '.play-btn');
      await evalJs(cdp, `(() => { const stage = document.querySelector('.player-stage') || document.body; stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 1; })()`);
      await sleep(400);
    }

    // ------------------------------------------------------------------
    console.log('\n== Tier 2: pause pressed DURING a seek-restart ==');
    {
      ok('ts re-selected', await playPath(cdp, ts, 'tsA'));
      const r = await seekAndClickInRestart(cdp);
      ok('click landed inside a real restart window', r.rebuilding === true, JSON.stringify(r));
      // Playing -> the button shows the pause glyph; it must never flash the
      // play glyph just because the element was transiently detached.
      ok('play button does not flip while the pipeline rebuilds', !r.labelBefore.includes('⏵'), `before=${r.labelBefore}`);
      await settle(cdp, 3000);
      const after = await snap(cdp);
      ok('pause pressed mid-restart stays paused', after.paused === true, JSON.stringify(after));
      ok('pause pressed mid-restart lands at the seek target', Math.abs(after.ft - r.target) < 2.5, `ft=${after.ft} want=${r.target}`);
      await sleep(3000);
      const later = await snap(cdp);
      ok('no late auto-resume after a mid-restart pause', later.paused === true, JSON.stringify(later));
    }

    // ------------------------------------------------------------------
    console.log('\n== Tier 2: play pressed DURING a seek-restart ==');
    {
      ok('ts re-selected', await playPath(cdp, ts, 'tsB'));
      // Paused first, so the transport click during the restart means PLAY.
      await evalJs(cdp, clickPlayBtn);
      ok('paused before the restart', !!(await waitPaused(cdp, 6000))?.paused);
      const r = await seekAndClickInRestart(cdp);
      ok('click landed inside a real restart window', r.rebuilding === true, JSON.stringify(r));
      await settle(cdp, 1000);
      const playing = await waitPlaying(cdp, 30000);
      const after = await snap(cdp);
      ok('play mid-restart resumes playback', !!playing && !after.paused, JSON.stringify(after));
      ok('play mid-restart does NOT reload from 0', Math.abs(after.ft - r.target) < 4, `ft=${after.ft} want=${r.target}`);
    }

    // ------------------------------------------------------------------
    console.log('\n== Tier 2: pause → seek → play ==');
    {
      ok('ts re-selected', await playPath(cdp, ts, 'tsC'));
      await evalJs(cdp, `(async () => { document.querySelector('video').pause(); await new Promise((r) => setTimeout(r, 400)); })()`);
      ok('pause works', !!(await waitPaused(cdp, 6000))?.paused);
      await evalJs(cdp, `(async () => { await window.__moviraServices.engine.seek(40); })()`);
      await settle(cdp, 1500);
      const afterSeek = await snap(cdp);
      ok('paused seek lands exactly and stays paused', Math.abs(afterSeek.ft - 40) < 1.5 && afterSeek.paused === true, JSON.stringify(afterSeek));
      await evalJs(cdp, clickPlayBtn);
      const resumed = await waitPlaying(cdp, 20000);
      ok('play after a paused seek resumes from the seek point', !!resumed && Math.abs(resumed.ft - 40) < 4, JSON.stringify(resumed));
    }

    // ------------------------------------------------------------------
    console.log('\n== Keyboard Space round trips ==');
    {
      ok('ts re-selected', await playPath(cdp, ts, 'tsD'));
      await evalJs(cdp, keyExpr(' '));
      const p1 = await waitPaused(cdp, 6000);
      ok('Space pauses', !!p1, JSON.stringify(p1));
      await evalJs(cdp, keyExpr(' '));
      const r1 = await waitPlaying(cdp, 8000);
      ok('Space resumes from the same position', !!r1 && Math.abs(r1.ft - (p1 ? p1.ft : 0)) < 2, JSON.stringify(r1));
      // Two presses in the SAME task (what a key auto-repeat looks like) must
      // toggle twice — reading a STALE mirror made both presses call pause()
      // and a quick double-tap looked like "pause does not work".
      const twice = JSON.parse(await evalJs(cdp, `(async () => {
        const k = { key: ' ', bubbles: true, cancelable: true };
        document.body.dispatchEvent(new KeyboardEvent('keydown', k));
        document.body.dispatchEvent(new KeyboardEvent('keydown', k));
        await new Promise((r) => setTimeout(r, 1500));
        return JSON.stringify({ paused: document.querySelector('video').paused });
      })()`));
      ok('two Space presses in one task toggle twice (was playing -> playing)', twice.paused === false, JSON.stringify(twice));
      await evalJs(cdp, keyExpr(' '));
      ok('paused again before the mirrored check', !!(await waitPaused(cdp, 6000))?.paused);
      const twice2 = JSON.parse(await evalJs(cdp, `(async () => {
        const k = { key: ' ', bubbles: true, cancelable: true };
        document.body.dispatchEvent(new KeyboardEvent('keydown', k));
        document.body.dispatchEvent(new KeyboardEvent('keydown', k));
        await new Promise((r) => setTimeout(r, 1500));
        return JSON.stringify({ paused: document.querySelector('video').paused });
      })()`));
      ok('two Space presses in one task toggle twice (was paused -> paused)', twice2.paused === true, JSON.stringify(twice2));
    }

    // ------------------------------------------------------------------
    console.log('\n== Tier 1 (native): pause / play round trip ==');
    {
      ok('mp4 re-selected', await playPath(cdp, mp4, 'mp4B'));
      await evalJs(cdp, clickPlayBtn);
      const p1 = await waitPaused(cdp, 6000);
      ok('native pause', !!p1);
      const t1 = p1 ? p1.ft : 0;
      await sleep(1200);
      const drift = await snap(cdp);
      ok('native clock is frozen while paused', Math.abs(drift.ft - t1) < 0.3, `${t1} -> ${drift.ft}`);
      await evalJs(cdp, clickPlayBtn);
      const r1 = await waitPlaying(cdp, 8000);
      ok('native play resumes from the paused position', !!r1 && r1.ft >= t1 - 0.5 && r1.ft < t1 + 3, JSON.stringify(r1));
    }

    // ------------------------------------------------------------------
    console.log('\n== A paused element stops consuming the stream ==');
    {
      ok('ts re-selected', await playPath(cdp, ts, 'tsE'));
      await sleep(2500);
      await evalJs(cdp, clickPlayBtn);
      await waitPaused(cdp, 6000);
      await sleep(1200);
      const b1 = await evalJs(cdp, `(() => { const d = window.__moviraMseDebug; return d ? d.byteCount : -1; })()`);
      await sleep(3000);
      const b2 = await evalJs(cdp, `(() => { const d = window.__moviraMseDebug; return d ? d.byteCount : -1; })()`);
      const growth = b2 - b1;
      ok('append loop backs off while paused', b1 > 0 && growth >= 0 && growth < b1 * 0.35, `bytes ${b1} -> ${b2} (+${growth})`);
      await evalJs(cdp, clickPlayBtn);
      const r = await waitPlaying(cdp, 20000);
      ok('playback resumes after a long pause', !!r, JSON.stringify(r));
      const adv = JSON.parse(await evalJs(cdp, `(async () => {
        const eng = window.__moviraServices.engine; const a = eng.currentFileTime();
        await new Promise((x) => setTimeout(x, 1500));
        return JSON.stringify({ moved: eng.currentFileTime() > a + 0.5, ft: +eng.currentFileTime().toFixed(2) });
      })()`));
      ok('playback keeps advancing after the pause', adv.moved, JSON.stringify(adv));
    }

    ok('no renderer exceptions during the whole run', cdp.logs.length === 0, cdp.logs.slice(0, 3).join(' | '));
    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    try { child.kill(); } catch { /* ignore */ }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });