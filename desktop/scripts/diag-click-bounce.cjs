/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * SINGLE-CLICK TIMELINE BOUNCE DIAGNOSTIC.
 *
 * The user reports that ONE click on the timeline moves the playhead like this:
 *
 *     2:00  ->  10:00  ->  2:00  ->  10:00
 *
 * i.e. the cursor lands, snaps BACK to the old position, then lands again. The
 * same shape is reported forward (11:00 -> 22:00 -> 11:00 -> 22:00) and
 * backward (22:00 -> 10:00 -> 22:00 -> 10:00), so it is not a decode artefact:
 * it is the UI showing a DIFFERENT number than the engine is at, twice.
 *
 * Therefore this script measures TWO clocks at once, sampled by the page's own
 * rAF loop (never over CDP, which is too slow to see the bounce):
 *
 *   engine  = window.__moviraServices.engine.currentFileTime()   (truth)
 *   visible = the position the TIMELINE THUMB IS ACTUALLY DRAWN AT
 *             (.timeline-thumb -> left% -> seconds) and the printed label
 *             (.progress-row .time)
 *
 * and counts HTMLMediaElement.currentTime writes for the whole click.
 *
 * A bounce is detected as any visible sample that returns to within 1 s of the
 * pre-click position AFTER the click, or any visible/engine disagreement
 * greater than 1 s.
 *
 * Usage: node scripts/diag-click-bounce.cjs [abs-or-relative-movie-path]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Movira.exe');
const MEDIA = path.join(ROOT, 'testmedia');
const CDP_PORT = 9800 + (process.pid % 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = () => path.join(os.tmpdir(), `movira-bounce-${process.pid}`);

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') { /* seen below via errs */ }
      if (m.method === 'Runtime.exceptionThrown') this.errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    });
  }
  send(method, params = {}, ms = 60000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
      setTimeout(() => rej(new Error('CDP timeout: ' + method)), ms);
    });
  }
}
async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('renderer: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

const hhmmss = (s) => {
  if (!isFinite(s) || s < 0) return '??:??';
  const t = Math.round(s);
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};

/** Records the thumb position, the printed label and the engine position at
 *  rAF cadence, plus every currentTime write. Installed once per run. */
const HOOK = `(() => {
  const W = window;
  if (W.__bc) return 'already';
  const now = () => performance.now();
  const visibleTime = () => {
    const track = document.querySelector('.timeline');
    if (!track) return -1;
    const thumb = document.querySelector('.timeline-thumb');
    const rect = track.getBoundingClientRect();
    let pct = NaN;
    if (thumb && rect.width > 0) {
      // thumb is positioned with left: N% and is 12px wide; recover the
      // fraction of the TRACK it represents (the app centres it on the edge).
      const tr = thumb.getBoundingClientRect();
      pct = (tr.left + tr.width / 2 - rect.left) / rect.width;
    }
    const dur = W.__moviraServices.engine.knownDuration();
    if (!isFinite(pct) || !isFinite(dur) || dur <= 0) return -1;
    return pct * dur;
  };
  const labelText = () => {
    const el = document.querySelector('.progress-row .time');
    return el ? el.textContent : '';
  };
  W.__bc = { on: false, rows: [], writes: [], frames: 0, beat: 0, err: null };
  // ---- currentTime write spy: (value, stack-free source tag, t) -----------
  const P = HTMLMediaElement.prototype;
  const dc = Object.getOwnPropertyDescriptor(P, 'currentTime');
  Object.defineProperty(P, 'currentTime', {
    get() { return dc.get.call(this); },
    set(v) {
      if (W.__bc.on) W.__bc.writes.push([Math.round(now()), +Number(v).toFixed(2)]);
      return dc.set.call(this, v);
    }, configurable: true,
  });
  // ---- key media events, stamped IN PAGE ---------------------------------
  const v = document.querySelector('video');
  if (v) {
    for (const ev2 of ['seeking', 'seeked', 'timeupdate']) {
      v.addEventListener(ev2, () => {
        if (W.__bc.on) W.__bc.rows.push([Math.round(now()), 'E:' + ev2, +v.currentTime.toFixed(2), visibleTime(), labelText()]);
      });
    }
  }
  const sample = () => {
    W.__bc.beat++;
    if (!W.__bc.on) return;
    try {
      const e = W.__moviraServices.engine;
      const vis = visibleTime();
      W.__bc.rows.push([Math.round(now()), 'f', +e.currentFileTime().toFixed(2), +vis.toFixed(2), labelText()]);
      W.__bc.frames++;
      if (W.__bc.rows.length > 4000) W.__bc.rows.shift();
    } catch (err) {
      W.__bc.err = String((err && err.stack) || err);
    }
  };
  // TWO INDEPENDENT CLOCKS. The rAF loop re-arms ONLY itself — letting the
  // interval tick call requestAnimationFrame spawned a fresh rAF chain per
  // tick and the sampler ran at ~1.5 kHz, which overflowed the row buffer and
  // threw away the very frames the click was measured from.
  const frameTick = () => { requestAnimationFrame(frameTick); sample(); };
  requestAnimationFrame(frameTick);
  // Belt and braces: rAF is throttled to zero when the window is occluded or
  // unfocused, which intermittently silenced the capture entirely.
  setInterval(sample, 16);
  return 'hooked';
})()`;

/** Freeze the recorded frames into a compact "sequence of distinct visible
 *  positions" so a 3 s capture reads as the arrow sequence the user sees. */
const SEQUENCE = `(() => {
  const rows = window.__bc.rows;
  const seq = [];
  for (const r of rows) {
    if (r[1] !== 'f') continue;
    const vis = r[3];
    const last = seq[seq.length - 1];
    if (last && Math.abs(last.vis - vis) < 0.6 && Math.abs(last.eng - r[2]) < 0.6) { last.n++; last.t1 = r[0]; continue; }
    seq.push({ t: r[0], vis, eng: r[2], label: r[4], n: 1, t1: r[0] });
  }
  return JSON.stringify(seq.map(s => ({ t: s.t, dt: s.t1 - s.t, vis: +s.vis.toFixed(1), eng: +s.eng.toFixed(1), label: s.label, frames: s.n })));
})()`;

async function trackBox(cdp) {
  return JSON.parse(await ev(cdp, `(() => {
    const el = document.querySelector('.timeline');
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    const dur = window.__moviraServices.engine.knownDuration();
    return JSON.stringify({ left: r.left, width: r.width, y: Math.round(r.top + r.height / 2), dur });
  })()`));
}

/** One trusted click at `x` on the track, shaped like a HUMAN click: the button
 *  is HELD for `holdMs` (a real press lasts 60-150 ms, and a synthetic
 *  press+release pair dispatched back-to-back holds it for 0 ms) and the hand
 *  wanders a pixel or two before releasing. Both matter: the press duration is
 *  the window in which the app must keep showing the clicked position. */
async function oneClick(cdp, x, y, holdMs = 120, jitter = 1) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, 20000);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }, 20000);
  if (holdMs > 0) await sleep(holdMs);
  if (jitter) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + jitter, y, button: 'left', buttons: 1 }, 20000).catch(() => {});
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + jitter, y, button: 'left', clickCount: 1, buttons: 0 }, 20000);
}

/** One click trial: seek from `fromSec` to `frac` of the timeline. */
async function trial(cdp, box, fromSec, frac, label) {
  const target = Math.round(box.dur * frac);
  // Park the playhead at the start position with a direct engine seek and let
  // it settle, so the click is measured from a known, stable origin.
  await ev(cdp, `window.__moviraServices.engine.seek(${fromSec}).catch(()=>{})`);
  await sleep(1500);
  const before = JSON.parse(await ev(cdp, `(() => { const e = window.__moviraServices.engine;
    return JSON.stringify({ eng: +e.currentFileTime().toFixed(2), dur: e.knownDuration(), thumb: +document.querySelector('.timeline-thumb').getBoundingClientRect().left.toFixed(1) }); })()`));

  await ev(cdp, `(() => { const b = window.__bc; b.rows.length = 0; b.writes.length = 0; b.on = true; return 1; })()`);
  const x = Math.round(box.left + box.width * frac);
  await oneClick(cdp, x, box.y);
  await sleep(2600);
  await ev(cdp, `(() => { window.__bc.on = false; return 1; })()`);

  const seq = JSON.parse(await ev(cdp, SEQUENCE));
  const bcState = JSON.parse(await ev(cdp, `JSON.stringify({ frames: window.__bc.frames, beat: window.__bc.beat, err: window.__bc.err, rows: window.__bc.rows.length })`));
  if (bcState.err) console.log('     SAMPLER ERROR:', bcState.err);
  if (!bcState.frames) console.log('     SAMPLER DEAD: 0 frames recorded (heartbeat=' + bcState.beat + '), rows=' + bcState.rows);
  else if (bcState.frames < 60) console.log(`     WARNING: only ${bcState.frames} frames in 2.6 s — window is throttled, results unreliable`);
  const writes = JSON.parse(await ev(cdp, `JSON.stringify(window.__bc.writes)`));
  const events = JSON.parse(await ev(cdp, `JSON.stringify(window.__bc.rows.filter(r => r[1] !== 'f').slice(0, 24))`));

  console.log(`\n  --- ${label}: ${hhmmss(before.eng)}  ->  click at ${hhmmss(target)} (${(frac * 100).toFixed(0)}%) ---`);
  console.log('     visible timeline cursor / engine file time:');
  let t0 = seq.length ? seq[0].t : 0;
  for (const s of seq) {
    const d = Math.abs(s.vis - s.eng);
    const flag = d > 1.0 ? `   <== DISAGREE by ${d.toFixed(1)}s` : '';
    console.log(`       +${String(s.t - t0).padStart(5)}ms  cursor ${hhmmss(s.vis).padStart(7)}   engine ${hhmmss(s.eng).padStart(7)}   label ${String(s.label).padStart(7)}  x${s.frames}${flag}`);
  }
  console.log(`     media events: ${events.length ? events.map((e) => `${e[1]}@${e[2]}s`).join(' ') : '(none)'}`);
  console.log(`     currentTime writes during the click: ${writes.length} ${JSON.stringify(writes.map((w) => w[1]))}`);

  // ---- verdict -----------------------------------------------------------
  // Tolerance is PIXEL-derived: the click X is an integer pixel, so the real
  // target can differ from the ideal fraction by up to half a pixel, and one
  // pixel of this timeline is ~7 s. 4 px of slack is generous but still far
  // tighter than the 30-minute jumps being tested.
  const tol = Math.max(3, (box.dur / box.width) * 4);
  const startVis = before.eng;
  let bounced = false;
  let moved = false;
  for (const s of seq) {
    if (Math.abs(s.vis - target) < tol) moved = true;
    if (moved && Math.abs(s.vis - startVis) < tol) bounced = true;
  }
  const disagree = seq.filter((s) => Math.abs(s.vis - s.eng) > 1.0).length;
  const landed = seq.length ? Math.abs(seq[seq.length - 1].eng - target) < tol : false;
  console.log(`     VERDICT: bounced=${bounced}  cursorReachedTarget=${moved}  landedAtTarget=${landed}  cursor/engineDisagreeFrames=${disagree}  ${writes.length > 1 ? 'MULTI-SEEK' : ''}`);
  return { bounced, moved, landed, disagree, writes: writes.length, seq, target, start: startVis };
}

async function main() {
  console.log('Packaged exe:', EXE, fs.existsSync(EXE) ? '(found)' : '(MISSING)');
  const arg = process.argv[2];
  const file = arg ? (path.isAbsolute(arg) ? arg : path.join(MEDIA, arg)) : path.join(MEDIA, 'movie-2.86gb.mkv');
  if (!fs.existsSync(file)) throw new Error('file not found: ' + file);
  console.log('Movie:', file, `(${(fs.statSync(file).size / 1073741824).toFixed(2)} GB)`);

  const child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT, env: { ...process.env, MOVIRA_USER_DATA_DIR: profileDir() },
    stdio: 'ignore', windowsHide: true,
  });
  let hardFail = 0;
  const ok = (cond, msg) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) hardFail++; };
  try {
    let page = null;
    for (let i = 0; i < 90 && !page; i++) {
      await sleep(1000);
      try {
        const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        page = list.find((t) => t.type === 'page' && /dist[\\/]renderer[\\/]index\.html/.test(t.url));
      } catch { /* retry */ }
    }
    if (!page) throw new Error('packaged app page not found');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) { await sleep(500); ready = await ev(cdp, `!!(window.__moviraTestPlay && window.__moviraServices)`).catch(() => false); }
    if (!ready) throw new Error('renderer never became ready');
    // An unfocused/occluded Electron window has its rAF AND its timers throttled
    // to ~1 Hz, which starves BOTH this sampler and the app's own progress
    // pipeline (pushProgress rides a rAF). Measuring in that state produced
    // phantom "the cursor never reached the target" results. Force the page to
    // believe it is focused and visible before anything is measured.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await cdp.send('Page.bringToFront', {}).catch(() => {});
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    await sleep(1000);

    await ev(cdp, `(() => { window.__moviraTestPlay([{ id: 'b', type: 'video', title: 'bounce', path: ${JSON.stringify(file)} }], 0); return 1; })()`);
    let open = false;
    for (let i = 0; i < 240 && !open; i++) {
      await sleep(250);
      open = await ev(cdp, `(() => { const v=document.querySelector('video'); return !!(v && v.readyState >= 3 && !v.paused); })()`).catch(() => false);
    }
    if (!open) throw new Error('movie never reached playback');
    console.log('  playback started');
    await sleep(2000);
    await ev(cdp, HOOK);

    const box = await trackBox(cdp);
    if (!box) throw new Error('timeline not found');
    console.log(`  track: width=${box.width}px duration=${hhmmss(box.dur)}`);

    const far = box.dur * 0.42;
    const mid = box.dur * 0.20;
    const results = [];
    results.push(await trial(cdp, box, mid, 0.42, 'forward single click'));
    results.push(await trial(cdp, box, far, 0.20, 'backward single click'));
    results.push(await trial(cdp, box, mid, 0.72, 'forward single click (far)'));

    console.log('\n================ SUMMARY ================');
    results.forEach((r, i) => {
      ok(!r.bounced, `click ${i + 1}: cursor never returns to the pre-click position`);
      ok(r.moved && r.landed, `click ${i + 1}: cursor reached and stayed at the clicked position`);
      ok(r.disagree === 0, `click ${i + 1}: cursor and engine agree on every sampled frame (${r.disagree} disagreements)`);
      ok(r.writes <= 1, `click ${i + 1}: exactly one seek for one click (currentTime writes=${r.writes})`);
    });
    if (cdp.errs.length) console.log('renderer exceptions:', cdp.errs.slice(0, 5));
  } finally {
    try { child.kill(); } catch { /* ignore */ }
  }
  console.log(hardFail ? `\nRESULT: ${hardFail} FAILURES` : '\nRESULT: all checks passed');
  process.exit(hardFail ? 1 : 0);
}

main().catch((e) => { console.error('DIAG FAILED:', e.stack); process.exit(2); });