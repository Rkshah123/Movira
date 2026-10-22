/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * E2E regression: the Stop → reset → Play → seek flow.
 *
 * User report this guards against:
 *  - after Stop + Play, timeline clicks lag/never land again
 *  - playback sometimes freezes immediately after pressing Stop
 *
 * Root causes fixed (must stay fixed):
 *  - stop() used a global kill-all of ffmpeg sessions; a fast Play started a
 *    new session that the stale kill murdered (freeze right after restart)
 *  - MsePlayer leaked a 'canplay' listener per load/seek and revoked its blob
 *    URL while el.src still pointed at it → el.error poisoned the next load
 *  - Stop re-persisted the resume position; the restart then jumped into the
 *    unbuffered middle instead of 0
 *
 * Matrix: tier 1 (native mp4) and tier 2 (MPEG-TS via ffmpeg→MSE), each with
 * stop-state checks, exact timeline clicks after restart, repeated stop→play→
 * seek cycles, and a RAPID stop→play (no settle delay) race check.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-stopcycle-'));
function gen(file, args) {
  const out = path.join(tmp, file);
  const argv = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const a of args) {
    if (typeof a === 'string' && a.startsWith('-i')) argv.push('-f', 'lavfi');
    argv.push(a);
  }
  execFileSync(ffmpeg, [...argv, out], { timeout: 60000 });
  return out;
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      setTimeout(() => reject(new Error('CDP timeout: ' + method)), 120000);
    });
  }
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Renderer exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

async function waitForPage(cdpPort) {
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const list = await httpJson(`http://127.0.0.1:${cdpPort}/json/list`);
      const page = list.find((t) => t.type === 'page' && /dist[\\/]renderer[\\/]index\.html/.test(t.url));
      if (page) return page;
    } catch { /* retry */ }
  }
  throw new Error('app page not found');
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  return new Cdp(ws);
}

const STATE = `(() => {
  const v = document.querySelector('video');
  if (!v) return JSON.stringify({ none: true });
  return JSON.stringify({ src: v.src || '', blob: (v.src || '').startsWith('blob:'), rs: v.readyState, p: v.paused, t: v.currentTime, err: v.error ? v.error.code : null });
})()`;

async function getState(cdp) {
  return JSON.parse(await evalJs(cdp, STATE));
}

/** Poll until pred(state) holds or timeout. Returns last state. */
async function waitState(cdp, pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let s = await getState(cdp);
  while (Date.now() < deadline) {
    if (pred(s)) return s;
    await sleep(250);
    s = await getState(cdp);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(s)}`);
}

async function stop(cdp) {
  await evalJs(cdp, `(async () => { await window.__moviraServices.engine.stop(); return 'ok'; })()`);
}

async function play(cdp) {
  await evalJs(cdp, `(async () => { await window.__moviraServices.engine.play(); return 'ok'; })()`);
}

/** Single-click the real Timeline at frac, measure time to land. */
async function clickSeek(cdp, frac, timeoutMs) {
  const raw = await evalJs(cdp, `(async () => {
    const tl = document.querySelector('.timeline');
    if (!tl) return JSON.stringify({ fatal: 'no timeline' });
    const v = document.querySelector('video');
    let dur = v ? v.duration : NaN;
    // After a seek-restart the fresh MediaSource declares its duration on the
    // first append — wait briefly instead of bailing (harness-only guard).
    for (let i = 0; i < 30 && (!isFinite(dur) || dur <= 0); i++) {
      await new Promise((r) => setTimeout(r, 100));
      dur = (document.querySelector('video') || {}).duration;
    }
    if (!isFinite(dur) || dur <= 0) return JSON.stringify({ fatal: 'no duration' });
    const rect = tl.getBoundingClientRect();
    const want = ${frac} * dur;
    const x = rect.left + rect.width * ${frac};
    const y = rect.top + rect.height / 2;
    const t0 = performance.now();
    // A restart-flip re-render can replace the .timeline DOM node between hit
    // test and dispatch; re-resolve and retry so the click always reaches the
    // LIVE node (harness robustness only — the engine path is unchanged).
    for (let attempt = 0; attempt < 3; attempt++) {
      const node = document.querySelector('.timeline');
      if (!node) return JSON.stringify({ fatal: 'no timeline' });
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width * ${frac};
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      const el = hit && hit.closest && hit.closest('.timeline') ? hit : node;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 11 + attempt, pointerType: 'mouse', button: 0, isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 11 + attempt, pointerType: 'mouse', button: 0, isPrimary: true }));
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const vv = document.querySelector('video');
        if (!vv) return JSON.stringify({ fatal: 'video gone' });
        const ft = window.__moviraServices ? window.__moviraServices.engine.currentFileTime() : vv.currentTime;
        if (Math.abs(ft - want) < 0.75) return JSON.stringify({ ok: true, want: +want.toFixed(2), landedMs: Math.round(performance.now() - t0) });
      }
    }
    return JSON.stringify({ ok: false, want: +want.toFixed(2), t: (document.querySelector('video') || {}).currentTime ?? null });
  })()`);
  return JSON.parse(raw);
}

/** Assert the clock advances over 1.5s (no freeze). */
async function expectAdvancing(cdp, label) {
  const r = JSON.parse(await evalJs(cdp, `(async () => {
    const eng = window.__moviraServices.engine;
    const t1 = eng.currentFileTime();
    await new Promise((r2) => setTimeout(r2, 1500));
    const v2 = document.querySelector('video');
    const t2 = eng.currentFileTime();
    return JSON.stringify({ advanced: t2 > t1 + 0.5, from: +t1.toFixed(2), to: +t2.toFixed(2), p: v2.paused, rs: v2.readyState });
  })()`));
  ok(`${label}: playback keeps advancing (no freeze)`, r.advanced && !r.p, JSON.stringify(r));
  return r.advanced && !r.p;
}

/** Verify stopped state: source detached, paused, element healthy. */
async function expectStopped(cdp, label) {
  const s = await getState(cdp);
  ok(`${label}: stop detaches source, pauses, no element error`, !s.none && !s.src && s.p && s.err === null, JSON.stringify(s));
}

/** One stop → play → exact-click cycle. Returns true on success. */
async function stopPlaySeekCycle(cdp, label, frac, clickTimeout) {
  await stop(cdp);
  await expectStopped(cdp, `${label} [stop]`);
  await play(cdp);
  try {
    const s = await waitState(cdp, (st) => st.rs >= 3 && !st.p && st.t < 5, 20000, `${label} restart`);
    const click = await clickSeek(cdp, frac, clickTimeout);
    const landed = click.ok && click.landedMs < clickTimeout;
    ok(`${label}: stop → play → click ${(frac * 100).toFixed(0)}% landed exact + fast`,
      landed, `restart t=${s.t.toFixed(2)}, click ${JSON.stringify(click)}`);
    return landed;
  } catch (e) {
    ok(`${label}: stop → play → click ${(frac * 100).toFixed(0)}% landed exact + fast`, false, String(e.message || e));
    return false;
  }
}

async function main() {
  const mp4 = gen('movie.mp4', ['-i', 'testsrc=size=320x240:rate=25:duration=90', '-i', 'sine=frequency=440:duration=90,volume=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-b:a', '96k', '-f', 'mp4']);
  const ts = gen('movie.ts', ['-i', 'testsrc=size=320x240:rate=25:duration=90', '-i', 'sine=frequency=550:duration=90,volume=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts']);

  console.log('Launching app with a file argument (native tier 1)...');
  const child = spawn(process.execPath.includes('electron') ? electron : path.join(__dirname, '..', 'release', 'win-unpacked', 'Movira.exe'), [process.execPath.includes('electron') ? '.' : '', mp4, `--remote-debugging-port=${CDP_PORT}`, '--enable-logging'], {
    cwd: path.join(__dirname, '..'),      env: { ...process.env, MOVIRA_USER_DATA_DIR: profileDir() },

    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const mainLog = [];
  child.stdout.on('data', (d) => { const s = d.toString(); mainLog.push(s); if (/movira:stream/.test(s)) console.log('  [main] ' + s.trim().split('\n').join('\n         ')); });
  child.stderr.on('data', (d) => { const s = d.toString(); mainLog.push(s); if (/movira:stream/.test(s)) console.log('  [main] ' + s.trim().split('\n').join('\n         ')); });

  try {
    const cdp = await connect(await waitForPage(CDP_PORT));

    // Wait for services + tier-1 autoplay of the launched file.
    let s = null;
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      s = await getState(cdp);
      if (!s.none && s.rs >= 3 && !s.p && s.t > 0.5) break;
    }
    ok('tier 1 (native): launch autoplays', !s.none && s.rs >= 3 && !s.p && s.t > 0.5, JSON.stringify(s));

    console.log('\n== Tier 1 (native mp4): stop → play → seek ==');
    await stop(cdp);
    await expectStopped(cdp, 'tier 1');
    await play(cdp);
    const r1 = await waitState(cdp, (st) => st.rs >= 3 && !st.p && st.t < 5, 15000, 'tier-1 restart');
    ok('tier 1: Play after Stop restarts from the beginning', r1.t < 5, `t=${r1.t.toFixed(2)}`);

    // Exact timeline clicks right after the restart — the reported lag zone.
    const clickTimeout1 = 4000;
    const targets1 = [0.15, 0.5, 0.85, 0.3];
    let allFast1 = true;
    for (const frac of targets1) {
      const c = await clickSeek(cdp, frac, 8000);
      const good = c.ok && c.landedMs < clickTimeout1;
      if (!good) allFast1 = false;
      console.log(`    click ${(frac * 100).toFixed(0)}% → ${c.ok ? `landed in ${c.landedMs}ms` : 'NEVER LANDED'} ${JSON.stringify(c)}`);
      await sleep(400);
    }
    ok('tier 1: timeline clicks after Stop→Play are exact and fast (<4s)', allFast1);
    await expectAdvancing(cdp, 'tier 1');

    // Repeated stop → play → seek cycles (state/listener leak regression).
    let cyclesOk = true;
    for (let i = 0; i < 3; i++) {
      const good = await stopPlaySeekCycle(cdp, `tier 1 cycle ${i + 1}`, [0.55, 0.4, 0.65][i], 6000);
      if (!good) cyclesOk = false;
      await sleep(300);
    }
    ok('tier 1: 3 repeated stop→play→seek cycles stay stable', cyclesOk);

    // RAPID stop→play (no settle): the old kill-all race window.
    await stop(cdp);
    await play(cdp);
    try {
      const rs = await waitState(cdp, (st) => st.rs >= 3 && !st.p && st.t < 5, 15000, 'tier-1 rapid restart');
      ok('tier 1: rapid Stop→Play restarts cleanly', rs.t < 5, `t=${rs.t.toFixed(2)}`);
    } catch (e) {
      ok('tier 1: rapid Stop→Play restarts cleanly', false, String(e.message || e));
    }

    console.log('\n== Tier 2 (MPEG-TS via ffmpeg→MSE): stop → play → seek ==');
    await evalJs(cdp, `(async () => {
      window.__moviraTestPlay([{ id: 'tts', type: 'video', title: 'ts-stream', path: ${JSON.stringify(ts)} }], 0);
      return 'loaded';
    })()`);
    let s2 = null;
    let tier2Started = false;
    for (let i = 0; i < 300; i++) {
      await sleep(500);
      s2 = await getState(cdp);
      if (s2.blob && s2.rs >= 3 && !s2.p && s2.t > 0.5) { tier2Started = true; break; }
    }
    ok('tier 2 (MSE): .ts starts playing via MediaSource', tier2Started, JSON.stringify(s2));

    // Exact clicks on the MSE tier (seek = ffmpeg restart at offset).
    const clickTimeout2 = 6000;
    let allFast2 = true;
    for (const frac of [0.2, 0.6, 0.85, 0.35]) {
      const c = await clickSeek(cdp, frac, 10000);
      const good = c.ok && c.landedMs < clickTimeout2;
      if (!good) allFast2 = false;
      console.log(`    click ${(frac * 100).toFixed(0)}% → ${c.ok ? `landed in ${c.landedMs}ms` : 'NEVER LANDED'} ${JSON.stringify(c)}`);
      await sleep(400);
    }
    ok('tier 2: timeline clicks are exact and fast (<6s)', allFast2);
    if (!allFast2) {
      // Debug-only: call engine.seek directly and trace what happens.
      const probe = JSON.parse(await evalJs(cdp, `(async () => {
        const s = window.__moviraServices;
        const v = document.querySelector('video');
        const before = { elT: v.currentTime, ft: s.engine.currentFileTime(), rs: v.readyState, p: v.paused };
        const b = v.buffered; const ranges = [];
        for (let i = 0; i < b.length; i++) ranges.push([+b.start(i).toFixed(1), +b.end(i).toFixed(1)]);
        let seekResult = 'ok';
        try { await s.engine.seek(18); } catch (e) { seekResult = 'THREW: ' + String(e && e.message || e); }
        await new Promise((r) => setTimeout(r, 2500));
        const after = { elT: v.currentTime, ft: s.engine.currentFileTime(), rs: v.readyState, p: v.paused, err: v.error ? v.error.code : null };
        return JSON.stringify({ before, ranges, seekResult, after });
      })()`));
      console.log('    [debug seek-probe]', JSON.stringify(probe));
    }
    const advancing2 = await expectAdvancing(cdp, 'tier 2');
    if (!advancing2) {
      // Debug-only: probe the frozen moment immediately.
      const frozen = JSON.parse(await evalJs(cdp, `(() => {
        const v = document.querySelector('video');
        const d = window.__moviraMseDebug;
        const b = v?.buffered; const ranges = [];
        if (b) for (let i = 0; i < b.length; i++) ranges.push([+b.start(i).toFixed(2), +b.end(i).toFixed(2)]);
        return JSON.stringify({
          rs: v?.readyState, p: v?.paused, t: v?.currentTime, ended: v?.ended,
          err: v?.error ? v.error.code : null, buffered: ranges,
          appendCount: d?.appendCount, byteCount: d?.byteCount, appendErrors: d?.appendErrors,
          fetchDone: d?.fetchDone, fetchFailed: d?.fetchFailed, destroyed: d?.destroyed,
          msReady: d?.debugMsState(), sbUpdating: d?.debugSbUpdating(),
          bufStart: d?.debugBufStart, seekApplied: d?.debugSeekApplied, target: d?.debugTargetTime,
          ranges: d?.debugBufferedRanges(),
        });
      })()`));
      console.log('    [debug frozen]', JSON.stringify(frozen));
    }

    // THE regression: Stop then IMMEDIATELY Play on tier 2. The stale
    // stopStreams kill-all used to murder the new session → frozen video.
    await stop(cdp);
    await expectStopped(cdp, 'tier 2');
    await play(cdp);
    try {
      const rs2 = await waitState(cdp, (st) => st.blob && st.rs >= 3 && !st.p, 90000, 'tier-2 restart after stop');
      ok('tier 2: Stop→Play restarts the MSE stream (no killed-session freeze)', rs2.blob && rs2.rs >= 3 && !rs2.p, `t=${rs2.t.toFixed(2)}`);
      const c2 = await clickSeek(cdp, 0.5, 10000);
      ok('tier 2: seek right after Stop→Play lands exactly', c2.ok && c2.landedMs < clickTimeout2, JSON.stringify(c2));
      await expectAdvancing(cdp, 'tier 2 after restart');
    } catch (e) {
      ok('tier 2: Stop→Play restarts the MSE stream (no killed-session freeze)', false, String(e.message || e));
      ok('tier 2: seek right after Stop→Play lands exactly', false, 'restart failed');
    }

    try { cdp.ws.close(); } catch { /* gone */ }
  } finally {
    child.kill();
    await sleep(400);
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  }

  console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('E2E crashed:', e); process.exit(1); });
