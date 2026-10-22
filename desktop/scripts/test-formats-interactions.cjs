/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * E2E: full format + interaction matrix (desktop).
 *
 *  - formats: .mp4 (tier 1 native), .mkv (tier 2 remux), .ts (tier 2 remux),
 *    .webm (tier 1 native) — each must play smoothly, advance, and survive
 *    repeated exact timeline clicks without lag/instability.
 *  - pause → seek → play on tier 1 AND tier 2 (must land while paused, stay
 *    paused, then resume advancing exactly from there).
 *  - keyboard: C cycles video zoom, V loads a sidecar subtitle, B cycles audio
 *    tracks without disturbing playback.
 *  - secondary windows: Settings/Playlist/Library open as floating panels,
 *    close on outside click AND Escape, reopen cleanly.
 *  - fullscreen: button enters, Escape leaves, player stays stable.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-formats-'));
function gen(file, args) {
  const out = path.join(tmp, file);
  const argv = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const a of args) {
    if (typeof a === 'string' && a.startsWith('-i')) argv.push('-f', 'lavfi');
    argv.push(a);
  }
  execFileSync(ffmpeg, [...argv, out], { timeout: 90000 });
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

/** Dispatch a real key event sequence on document.body — user keystrokes
 *  bubble body → document → window, so BOTH the document-level (floating
 *  panel Escape) and window-level (App shortcuts) listeners receive them. */
function keyExpr(key, opts = '') {
  return `(() => {
    const opts = ${opts || `{ key: '${key}', bubbles: true, cancelable: true }`};
    document.body.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.body.dispatchEvent(new KeyboardEvent('keyup', opts));
  })()`;
}

/** Click the timeline at frac and wait for currentFileTime to land (±0.75s). */
async function clickSeek(cdp, frac, timeoutMs) {
  const raw = await evalJs(cdp, `(async () => {
    const tl = document.querySelector('.timeline');
    if (!tl) return JSON.stringify({ fatal: 'no timeline' });
    let dur = (document.querySelector('video') || {}).duration;
    for (let i = 0; i < 30 && (!isFinite(dur) || dur <= 0); i++) {
      await new Promise((r) => setTimeout(r, 100));
      dur = (document.querySelector('video') || {}).duration;
    }
    if (!isFinite(dur) || dur <= 0) return JSON.stringify({ fatal: 'no duration' });
    const want = ${frac} * dur;
    const t0 = performance.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      const node = document.querySelector('.timeline');
      if (!node) return JSON.stringify({ fatal: 'no timeline' });
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width * ${frac};
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      const el = hit && hit.closest && hit.closest('.timeline') ? hit : node;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 51 + attempt, pointerType: 'mouse', button: 0, isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 51 + attempt, pointerType: 'mouse', button: 0, isPrimary: true }));
      for (let i = 0; i < Math.ceil(${timeoutMs} / 100); i++) {
        await new Promise((r) => setTimeout(r, 100));
        const vv = document.querySelector('video');
        if (!vv) return JSON.stringify({ fatal: 'video gone' });
        const ft = window.__moviraServices ? window.__moviraServices.engine.currentFileTime() : vv.currentTime;
        if (Math.abs(ft - want) < 0.75) return JSON.stringify({ ok: true, want: +want.toFixed(2), landedMs: Math.round(performance.now() - t0) });
      }
    }
    return JSON.stringify({ ok: false, want: +want.toFixed(2) });
  })()`);
  return JSON.parse(raw);
}

async function playPath(cdp, p, label) {
  // WAIT for the renderer to be usable. /json/list reports the page before
  // createServices() resolves, and this used to return 'no services' silently
  // — the hook was never called, nothing loaded, and the first file of the run
  // failed at cold start roughly one run in four.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(500);
    ready = await evalJs(cdp, `!!(window.__moviraServices && typeof window.__moviraTestPlay === 'function')`).catch(() => false);
  }
  if (!ready) throw new Error('renderer never became ready');
  const r = await evalJs(cdp, `(async () => {
    const s = window.__moviraServices;
    if (!s) return 'no services';
    window.__moviraTestPlay([{ id: 'fmt-${label}', type: 'video', title: '${label}', path: ${JSON.stringify(p)} }], 0);
    return 'loaded';
  })()`);
  if (r !== 'loaded') throw new Error('playPath could not start playback: ' + r);
  // Wait until frames flow.
  let last = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const st = JSON.parse(await evalJs(cdp, `(() => {
      const v = document.querySelector('video');
      const s = window.__moviraServices;
      return JSON.stringify({
        rs: v ? v.readyState : -1, p: v ? v.paused : null, err: v && v.error ? v.error.code : null,
        src: v ? (v.currentSrc || '').slice(0, 40) : '', ft: s ? +s.engine.currentFileTime().toFixed(2) : -1,
        tier2: s ? s.engine.isFallbackBusy() : false,
        hasHook: typeof window.__moviraTestPlay === 'function',
        hasServices: !!s,
        cur: s ? (s.player.getCurrent() || {}).path || null : null,
        queueLen: s ? s.player.getQueue().items.length : -1,
        dom: [!!document.querySelector('.loading-screen'), !!document.querySelector('.player-view'), !!document.querySelector('.player-empty'), !!document.querySelector('.app')].join('/'),
      });
    })()`));
    last = st;
    if (!st.none && st.rs >= 3 && !st.p && st.err === null) return true;
  }
  console.error(`    ${label}: never reached playing — last state ${JSON.stringify(last)}`);
  return false;
}

async function main() {
  console.log('Generating format matrix (mp4 / mkv / ts / webm)...');
  const V = ['testsrc=size=320x240:rate=25:duration=90', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50'];
  const A = ['-c:a', 'aac', '-b:a', '96k'];
  const mp4 = gen('clip.mp4', ['-i', V[0], '-i', 'sine=frequency=440:duration=90,volume=0', V[1], V[2], V[3], V[4], ...A, '-f', 'mp4']);
  const mkv = gen('clip.mkv', ['-i', V[0], '-i', 'sine=frequency=550:duration=90,volume=0', V[1], V[2], V[3], V[4], ...A, '-f', 'matroska']);
  const ts = gen('clip.ts', ['-i', V[0], '-i', 'sine=frequency=660:duration=90,volume=0', V[1], V[2], V[3], V[4], ...A, '-f', 'mpegts']);
  const webm = gen('clip.webm', ['-i', V[0], '-i', 'sine=frequency=770:duration=90,volume=0', '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libvorbis', '-f', 'webm']);
  // Sidecar subtitle for key V.
  fs.writeFileSync(path.join(tmp, 'clip.srt'), '1\n00:00:01,000 --> 00:01:20,000\nMovira sidecar subtitle\n');

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

    // ------------------------------------------------------------------
    // FORMAT MATRIX: play → advance → 3 exact repeated clicks each
    // ------------------------------------------------------------------
    console.log('\n== Format matrix: mp4 / mkv / ts / webm ==');
    for (const [label, p, tier2] of [['mp4', mp4, false], ['mkv', mkv, true], ['ts', ts, true], ['webm', webm, false]]) {
      const played = await playPath(cdp, p, label);
      ok(`${label}: opens and plays (tier ${tier2 ? '2 MSE' : '1 native'})`, played);
      if (!played) continue;

      const adv = JSON.parse(await evalJs(cdp, `(async () => {
        const eng = window.__moviraServices.engine;
        const a = eng.currentFileTime();
        await new Promise((r) => setTimeout(r, 1200));
        return JSON.stringify({ advanced: eng.currentFileTime() > a + 0.5 });
      })()`));
      ok(`${label}: playback advances smoothly (no freeze)`, adv.advanced);

      let all = true;
      let worst = 0;
      for (const frac of [0.4, 0.75, 0.15]) {
        const c = await clickSeek(cdp, frac, tier2 ? 10000 : 4000);
        if (!c.ok || c.landedMs > 6000) { all = false; console.error(`    ${label} click ${(frac * 100) | 0}%: ${JSON.stringify(c)}`); }
        else worst = Math.max(worst, c.landedMs);
      }
      ok(`${label}: repeated clicks at different positions land exactly (worst ${worst}ms)`, all);

      // Stability after the clicks.
      const st = JSON.parse(await evalJs(cdp, `(async () => {
        const v = document.querySelector('video');
        const eng = window.__moviraServices.engine;
        const a = eng.currentFileTime();
        await new Promise((r) => setTimeout(r, 1000));
        return JSON.stringify({ moving: eng.currentFileTime() > a + 0.3, err: v && v.error ? v.error.code : null });
      })()`));
      ok(`${label}: stable after repeated seeking`, st.moving && st.err === null, JSON.stringify(st));
    }

    // ------------------------------------------------------------------
    // PAUSE → SEEK → PLAY (tier 2 current file is .webm — switch to .ts)
    // ------------------------------------------------------------------
    console.log('\n== Pause → seek → play (tier 2 MSE) ==');
    ok('ts re-selected for pause tests', await playPath(cdp, ts, 'ts2'));
    {
      await evalJs(cdp, `(async () => { document.querySelector('video').pause(); await new Promise((r) => setTimeout(r, 300)); })()`);
      const paused0 = JSON.parse(await evalJs(cdp, `JSON.stringify({ p: document.querySelector('video').paused })`));
      ok('pause works', paused0.p === true);
      const c = await clickSeek(cdp, 0.62, 12000);
      const after = JSON.parse(await evalJs(cdp, `(() => {
        const v = document.querySelector('video');
        return JSON.stringify({ p: v.paused, ft: window.__moviraServices.engine.currentFileTime(), want: 0.62 * v.duration });
      })()`));
      ok('tier 2: seek lands EXACTLY while paused', c.ok && after.p === true && Math.abs(after.ft - after.want) < 0.75, JSON.stringify({ c, after }));
      await evalJs(cdp, keyExpr(' '));
      await sleep(1200);
      const resumed = JSON.parse(await evalJs(cdp, `(async () => {
        const v = document.querySelector('video');
        const eng = window.__moviraServices.engine;
        const a = eng.currentFileTime();
        await new Promise((r) => setTimeout(r, 1000));
        return JSON.stringify({ p: v.paused, moving: eng.currentFileTime() > a + 0.3 });
      })()`));
      ok('tier 2: play after paused seek resumes from the seek point', !resumed.p && resumed.moving, JSON.stringify(resumed));
    }

    console.log('\n== Pause → seek → play (tier 1 native, mp4) ==');
    ok('mp4 re-selected', await playPath(cdp, mp4, 'mp42'));
    {
      await evalJs(cdp, `(async () => { document.querySelector('video').pause(); await new Promise((r) => setTimeout(r, 300)); })()`);
      const c = await clickSeek(cdp, 0.3, 6000);
      const after = JSON.parse(await evalJs(cdp, `(() => {
        const v = document.querySelector('video');
        return JSON.stringify({ p: v.paused, ft: v.currentTime, want: 0.3 * v.duration });
      })()`));
      ok('tier 1: seek lands exactly while paused', c.ok && after.p === true && Math.abs(after.ft - after.want) < 0.75, JSON.stringify(after));
      await evalJs(cdp, keyExpr(' '));
      await sleep(1000);
      const resumed = JSON.parse(await evalJs(cdp, `(() => JSON.stringify({ p: document.querySelector('video').paused }))()`));
      ok('tier 1: play resumes after paused seek', resumed.p === false);
    }

    // ------------------------------------------------------------------
    // KEYBOARD: C zoom, V sidecar subtitle, B audio track
    // ------------------------------------------------------------------
    console.log('\n== Keyboard: B / C / V ==');
    await evalJs(cdp, keyExpr('c'));
    await sleep(200);
    const z1 = JSON.parse(await evalJs(cdp, `JSON.stringify({ cls: document.querySelector('.video-host').className })`));
    ok('C: cycles video zoom (fit → fill)', /zoom-fill/.test(z1.cls), z1.cls);
    await evalJs(cdp, keyExpr('c'));
    await evalJs(cdp, keyExpr('c'));
    await sleep(200);
    const z3 = JSON.parse(await evalJs(cdp, `JSON.stringify({ cls: document.querySelector('.video-host').className })`));
    ok('C: cycles back to fit after fill + stretch', /zoom-fit/.test(z3.cls), z3.cls);

    await evalJs(cdp, keyExpr('v'));
    let subLoaded = false;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const t = JSON.parse(await evalJs(cdp, `(() => {
        const v = document.querySelector('video');
        const n = v ? v.textTracks.length : 0;
        const m = n > 0 ? v.textTracks[n - 1].mode : null;
        return JSON.stringify({ n, m });
      })()`));
      if (t.n > 0 && t.m === 'showing') { subLoaded = true; break; }
    }
    ok('V: loads the sidecar subtitle and shows it', subLoaded);
    await evalJs(cdp, keyExpr('v'));
    await sleep(400);
    const subOff = JSON.parse(await evalJs(cdp, `(() => {
      const v = document.querySelector('video');
      return JSON.stringify({ modes: Array.from(v.textTracks).map((t) => t.mode).join(',') });
    })()`));
    ok('V: toggles subtitles off again', !/showing/.test(subOff.modes), subOff.modes);

    const beforeB = JSON.parse(await evalJs(cdp, `(() => { const v = document.querySelector('video'); return JSON.stringify({ t: v.currentTime, p: v.paused }); })()`));
    await evalJs(cdp, keyExpr('b'));
    await sleep(500);
    const afterB = JSON.parse(await evalJs(cdp, `(async () => {
      const v = document.querySelector('video');
      const eng = window.__moviraServices.engine;
      const a = eng.currentFileTime();
      await new Promise((r) => setTimeout(r, 900));
      return JSON.stringify({ moving: eng.currentFileTime() > a + 0.3, err: v.error ? v.error.code : null });
    })()`));
    ok('B: audio-track cycle is safe (playback unaffected)', afterB.moving && afterB.err === null, JSON.stringify(afterB));

    // ------------------------------------------------------------------
    // SECONDARY WINDOWS: floating panels + outside click + Escape
    // ------------------------------------------------------------------
    console.log('\n== Secondary windows: Settings / Playlist / Library ==');
    const panelTest = async (navIndex, name) => {
      await evalJs(cdp, `(() => {
        const btns = document.querySelectorAll('.topbar .btn.topbar-nav');
        btns[${navIndex}].click();
      })()`);
      await sleep(350);
      const open = JSON.parse(await evalJs(cdp, `JSON.stringify({ panel: !!document.querySelector('.floating-panel'), backdrop: !!document.querySelector('.floating-backdrop') })`));
      // The panel is a floating window, NOT a modal: there must be no backdrop
      // element anywhere for a click to be swallowed by.
      ok(`${name}: opens as a floating window`, open.panel && !open.backdrop, JSON.stringify(open));
      // VLC behavior: the video keeps playing in the BACKGROUND while the
      // secondary window is open — opening a panel must never pause it.
      const bg = JSON.parse(await evalJs(cdp, `(() => {
        const v = document.querySelector('video');
        return JSON.stringify({ present: !!v, paused: v ? v.paused : null });
      })()`));
      ok(`${name}: Now Playing stays alive in the background (video present, still playing)`, bg.present && bg.paused === false, JSON.stringify(bg));
      // Click OUTSIDE the window (on the main screen behind it).
      await evalJs(cdp, `(() => {
        const stage = document.querySelector('.player-stage') || document.body;
        stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      })()`);
      await sleep(250);
      const closed = JSON.parse(await evalJs(cdp, `JSON.stringify({ panel: !!document.querySelector('.floating-panel') })`));
      ok(`${name}: click on the main screen hides it`, closed.panel === false);
      // Reopen, then Escape.
      await evalJs(cdp, `(() => { document.querySelectorAll('.topbar .btn.topbar-nav')[${navIndex}].click(); })()`);
      await sleep(300);
      const reopened = JSON.parse(await evalJs(cdp, `JSON.stringify({ panel: !!document.querySelector('.floating-panel') })`));
      ok(`${name}: reopens correctly`, reopened.panel === true);
      await evalJs(cdp, keyExpr('Escape'));
      await sleep(250);
      const escClosed = JSON.parse(await evalJs(cdp, `JSON.stringify({ panel: !!document.querySelector('.floating-panel') })`));
      ok(`${name}: Escape hides it`, escClosed.panel === false);
    };
    await panelTest(1, 'Library');
    await panelTest(2, 'Playlist');
    await panelTest(4, 'Settings');

    // ------------------------------------------------------------------
    // FULLSCREEN: enter via button, stable, Escape leaves
    // ------------------------------------------------------------------
    console.log('\n== Fullscreen ==');
    ok('video re-selected for fullscreen test', await playPath(cdp, mp4, 'mp43'));
    await evalJs(cdp, `(() => {
      const btns = document.querySelectorAll('.controls-row .right button');
      btns[btns.length - 1].click(); // fullscreen button (last in the right group)
    })()`);
    let fsOn = false;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const s = JSON.parse(await evalJs(cdp, `JSON.stringify({ fs: document.querySelector('.player-view').className.includes('fullscreen') })`));
      if (s.fs) { fsOn = true; break; }
    }
    ok('fullscreen: player view enters fullscreen mode', fsOn);
    const fsStable = JSON.parse(await evalJs(cdp, `(async () => {
      const eng = window.__moviraServices.engine;
      const a = eng.currentFileTime();
      await new Promise((r) => setTimeout(r, 900));
      return JSON.stringify({ moving: eng.currentFileTime() > a + 0.3 });
    })()`));
    ok('fullscreen: playback keeps running', fsStable.moving);
    await evalJs(cdp, keyExpr('Escape'));
    let fsOff = false;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const s = JSON.parse(await evalJs(cdp, `JSON.stringify({ fs: document.querySelector('.player-view').className.includes('fullscreen') })`));
      if (!s.fs) { fsOff = true; break; }
    }
    ok('fullscreen: Escape leaves fullscreen', fsOff);

    // Renderer exceptions anywhere in this run are a failure of their own.
    ok('no uncaught renderer exceptions during the whole run', cdp.logs.length === 0,
      cdp.logs.length ? cdp.logs[0].slice(0, 160) : '');

    ws.close();
  } finally {
    child.kill();
    await sleep(400);
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  }

  console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('formats E2E crashed:', e); process.exit(1); });
