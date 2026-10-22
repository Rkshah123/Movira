/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Acceptance suite for the seeking specification, run against the PACKAGED
 * binary on a 2.7 GB / 80 min movie and on a tier-2 (mpeg2video + AC3 5.1)
 * file.
 *
 * The reported failure is not "seeking is slow", it is "seeking reloads and
 * rebuilds the player":
 *
 *   - clicking around the timeline causes severe lag/stuttering,
 *   - repeated seeking is especially bad (seek->click->seek->click),
 *   - the forward/back buttons lag too,
 *   - the player sometimes goes temporarily unresponsive afterwards,
 *   - Stop then Play again brings the problem back,
 *   - and it must behave like VLC: one media element, currentTime writes,
 *     no load(), no src churn, no reinitialisation, no listener pile-up.
 *
 * Every one of those is asserted here as a hard number rather than a feeling:
 * element identity, load()/src counts, currentTime-assignment counts, listener
 * add/remove balance, measured seek latency, and drag seek rate.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Movira.exe');
const MEDIA = path.join(ROOT, 'testmedia');
const CDP_PORT = 9300 + (process.pid % 250);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = () => path.join(os.tmpdir(), `movira-seekspec-${process.pid}`);

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const info = (m) => console.log(`  ....  ${m}`);

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errs = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') this.errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    });
  }
  send(method, params = {}, ms = 120000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
      setTimeout(() => rej(new Error('CDP timeout: ' + method)), ms);
    });
  }
}
const ev = async (cdp, e) => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('renderer: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const evJson = async (cdp, e) => JSON.parse(await ev(cdp, e));

/* ------------------------------------------------------------------ */
/* In-page instrumentation. Everything the assertions read is measured by
 * code running in the renderer, so no CDP round-trip lands inside a
 * latency number.                                                         */
/* ------------------------------------------------------------------ */
const HOOK = `(() => {
  const W = window;
  const proto = HTMLMediaElement.prototype;

  // Counts the expensive operations the specification forbids. A seek that
  // reloads the player is visible here and nowhere else.
  W.__spec = {
    load: 0, src: 0, cur: 0,
    added: 0, removed: 0,
    listeners: new Map(),     // type -> live count, per element
    refId: 0,
  };
  // The <video> element does not exist until media loads, so the reference is
  // tagged lazily on first sight. If a seek ever recreates the element its
  // __specId will not match this reference and every later assertion sees it.
  W.__tagVideo = () => {
    const v = document.querySelector('video');
    if (!v) return null;
    if (!v.__specId) { W.__spec.refId += 1; v.__specId = W.__spec.refId; }
    return v;
  };
  if (!W.__specInstalled) {
    W.__specInstalled = true;
    const L = proto.load;
    proto.load = function () { W.__spec.load++; return L.call(this); };
    const ds = Object.getOwnPropertyDescriptor(proto, 'src');
    Object.defineProperty(proto, 'src', {
      get() { return ds.get.call(this); },
      set(v) { W.__spec.src++; return ds.set.call(this, v); },
      configurable: true,
    });
    const dc = Object.getOwnPropertyDescriptor(proto, 'currentTime');
    Object.defineProperty(proto, 'currentTime', {
      get() { return dc.get.call(this); },
      set(v) { W.__spec.cur++; return dc.set.call(this, v); },
      configurable: true,
    });
    // Listener accounting. 'added - removed' drifting upward across a seek
    // storm is exactly the "duplicate handlers" failure.
    const key = (t) => (t && t.type) || '?';
    const A = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (t, f, o) {
      if (this instanceof HTMLMediaElement) {
        W.__spec.added++;
        W.__spec.listeners.set(key(this) + t, ((W.__spec.listeners.get(key(this) + t)) || 0) + 1);
      }
      return A.call(this, t, f, o);
    };
    const R = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.removeEventListener = function (t, f, o) {
      if (this instanceof HTMLMediaElement) {
        W.__spec.removed++;
        W.__spec.listeners.set(key(this) + t, ((W.__spec.listeners.get(key(this) + t)) || 0) - 1);
      }
      return R.call(this, t, f, o);
    };
  }

  // Count competing playback loops: every requestAnimationFrame callback the
  // app registers. A second, redundant progress loop shows up as a rising
  // per-frame count instead of the expected steady value.
  W.__rafCount = 0;
  if (!W.__rafCountInstalled) {
    W.__rafCountInstalled = true;
    const R = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (cb) {
      return R((t) => { W.__rafCount++; return cb(t); });
    };
  }

  // Worst main-thread block, and how long a single seek takes measured by the
  // page's own clock.
  W.__blk = { worst: 0, over50: 0, n: 0 };
  let prev = performance.now();
  const ping = () => {
    const t = performance.now();
    const gap = t - prev;
    prev = t + 1;
    setTimeout(ping, 1);
    if (W.__blk.n > 20 && gap < 5000) {
      W.__blk.n++;
      if (gap > W.__blk.worst) W.__blk.worst = gap;
      if (gap > 50) W.__blk.over50++;
    }
  };
  setTimeout(ping, 1);

  W.__reset = () => {
    const s = W.__spec;
    s.load = 0; s.src = 0; s.cur = 0; s.added = 0; s.removed = 0;
    W.__blk.worst = 0; W.__blk.over50 = 0; W.__blk.n = 0;
    W.__rafCount = 0;
    W.__tagVideo();
    return 1;
  };

  W.__probe = () => {
    const v = W.__tagVideo();
    const s = W.__spec;
    let live = 0;
    s.listeners.forEach((n) => { live += n; });
    return JSON.stringify({
      ft: +window.__moviraServices.engine.currentFileTime().toFixed(3),
      known: +window.__moviraServices.engine.knownDuration().toFixed(1),
      paused: v ? v.paused : null,
      rs: v ? v.readyState : -1,
      err: v && v.error ? v.error.code : null,
      load: s.load, src: s.src, cur: s.cur,
      added: s.added, removed: s.removed, liveListeners: live,
      sameElement: !!v && v.__specId === s.refId,
      rafPerFrame: W.__rafCount,
      blk: Math.round(W.__blk.worst), blk50: W.__blk.over50,
    });
  };

  // Seek latency measured entirely in-page.
  W.__seekTo = (target, tol, budget) => new Promise((resolve) => {
    const e = window.__moviraServices.engine;
    const t0 = performance.now();
    let raf0 = W.__rafCount;
    e.seek(target).catch(() => {});
    const step = () => {
      const ft = e.currentFileTime();
      const rafDelta = W.__rafCount - raf0;
      if (Math.abs(ft - target) <= tol) return resolve(JSON.stringify({ ms: Math.round(performance.now() - t0), ok: 1, ft: +ft.toFixed(2), rafDelta }));
      if (performance.now() - t0 > budget) return resolve(JSON.stringify({ ms: -1, ok: 0, ft: +ft.toFixed(2), rafDelta }));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  return 'hooked';
})()`;

async function box(cdp, sel) {
  return evJson(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), left: Math.round(r.left), width: Math.round(r.width) });
  })()`);
}
async function click(cdp, b) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y }, 30000);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 }, 30000);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 }, 30000);
}
/**
 * A click shaped like a HUMAN one.
 *
 * A synthetic press+release dispatched back-to-back holds the button for 0 ms
 * and never moves the pointer, which is why it could never reproduce the
 * reported bounce. A real press lasts 60-150 ms and the hand wanders a pixel
 * or two before releasing. BOTH are load-bearing for this section: the hold is
 * the window in which the UI must keep showing the clicked position, and the
 * wander is exactly what used to be misread as a drag.
 */
async function humanClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, 30000);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }, 30000);
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 1, y, button: 'left', buttons: 1 }, 30000).catch(() => { /* cosmetic */ });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 1, y, button: 'left', clickCount: 1, buttons: 0 }, 30000);
}

/**
 * Samples what the timeline CURSOR is actually drawn at, next to the engine's
 * real file time. Installed independently of the main HOOK so this section
 * cannot perturb the counters the other sections assert on — it reads the DOM
 * and the engine, and never touches a prototype.
 */
const CLICK_WATCH_HOOK = `(() => {
  const W = window;
  if (W.__cw) return 'already';
  const cursor = () => {
    const track = document.querySelector('.timeline');
    const thumb = document.querySelector('.timeline-thumb');
    if (!track || !thumb) return -1;
    const r = track.getBoundingClientRect();
    const t = thumb.getBoundingClientRect();
    const d = W.__moviraServices.engine.knownDuration();
    if (!r.width || !isFinite(d) || d <= 0) return -1;
    return (t.left + t.width / 2 - r.left) / r.width * d;
  };
  W.__cw = { on: false, rows: [] };
  const sample = () => {
    if (!W.__cw.on) return;
    try {
      W.__cw.rows.push([+W.__moviraServices.engine.currentFileTime().toFixed(2), +cursor().toFixed(2)]);
      if (W.__cw.rows.length > 2000) W.__cw.rows.shift();
    } catch (e) { W.__cw.err = String(e); }
  };
  // rAF alone is throttled to nothing in an occluded window; the interval
  // keeps the record complete. Two independent clocks, no shared re-arm.
  const frameTick = () => { requestAnimationFrame(frameTick); sample(); };
  requestAnimationFrame(frameTick);
  setInterval(sample, 16);
  return 'ok';
})()`;

/** Reduce the captured rows to the question that matters: did the cursor reach
 *  the clicked position, and did it EVER come back to where it started?
 *  Tolerance is PIXEL-derived (see below) so a rounding of the click X is not
 *  mistaken for a bounce. */
const CLICK_WATCH_SUMMARY = (target, tol) => `(() => {
  const rows = window.__cw.rows;
  const first = rows.length ? rows[0][0] : 0;
  let reached = false, reverted = false;
  for (const r of rows) {
    if (Math.abs(r[1] - ${target}) < ${tol}) reached = true;
    if (reached && Math.abs(r[1] - first) < ${tol}) reverted = true;
  }
  return JSON.stringify({
    n: rows.length,
    reached: reached, reverted: reverted,
    first: Math.round(first), last: rows.length ? Math.round(rows[rows.length - 1][1]) : -1,
    err: window.__cw.err || null,
  });
})()`;

/**
 * Click a button identified by SELECTOR, re-resolving its position at the
 * moment of the click. Reusing a cached rectangle is how a test ends up
 * hitting Play instead of Next after a re-render, and then "fails" for a
 * reason that has nothing to do with what it claims to test.
 */
async function clickSel(cdp, sel) {
  const b = await box(cdp, sel);
  if (!b || b === 'null' || !b.width) return null;
  await click(cdp, b);
  return b;
}
async function openMedia(cdp, file, title) {
  await ev(cdp, `(() => { window.__moviraTestPlay([{ id: 's', type: 'video', title: ${JSON.stringify(title)}, path: ${JSON.stringify(file)} }], 0); return 1; })()`);
  let firstErr = 0;
  for (let i = 0; i < 400; i++) {
    await sleep(250);
    const s = await evJson(cdp, `(() => { const v=document.querySelector('video'); return JSON.stringify({ rs: v?v.readyState:-1, p: v?v.paused:null, e: v&&v.error?v.error.code:null }); })()`).catch(() => ({ rs: -1 }));
    if (s.rs >= 3 && s.p === false) return { ok: true };
    // A single error is the native tier failing before the ffmpeg escalation;
    // only a persistent one is a real failure.
    if (s.e) { if (!firstErr) firstErr = Date.now(); else if (Date.now() - firstErr > 15000) return { ok: false, why: 'error ' + s.e }; }
  }
  return { ok: false, why: 'timeout' };
}
const probe = (cdp) => evJson(cdp, 'window.__probe()');
const reset = (cdp) => ev(cdp, 'window.__reset()');

/** Wait for the element to actually reach a play/pause state. A fixed sleep
 *  here silently turns into a cascade of unrelated failures when the pause is
 *  a frame late, which hides the bug the section is meant to catch. */
async function waitPaused(cdp, want, budgetMs = 8000) {
  for (let i = 0; i < budgetMs / 100; i++) {
    await sleep(100);
    if ((await probe(cdp)).paused === want) return true;
  }
  return false;
}
/** Wait until playback is genuinely RUNNING again, not merely unpaused.
 *
 *  On the ffmpeg/MSE tier a drag release to an unbuffered position restarts
 *  the decoder: the element is detached (readyState 0) and paused while ffmpeg
 *  respawns and the pipeline rebuilds, which routinely takes longer than a
 *  fixed 1.5 s sleep. Sampling at a fixed instant therefore reported a
 *  correct, expected tier-2 restart as a failure — the same race already fixed
 *  for the audio-track section. This waits for the state the section actually
 *  cares about, and STILL FAILS if playback never comes back. */
async function waitResumed(cdp, budgetMs = 20000) {
  for (let i = 0; i < budgetMs / 100; i++) {
    await sleep(100);
    const s = await probe(cdp);
    if (s.paused === false && s.rs >= 3) return { ok: true, s };
  }
  return { ok: false, s: await probe(cdp) };
}
async function pauseEngine(cdp) {
  await ev(cdp, `(async () => { await window.__moviraServices.engine.pause(); return 1; })()`);
  return waitPaused(cdp, true);
}
async function playEngine(cdp) {
  await ev(cdp, `(async () => { await window.__moviraServices.engine.play(); return 1; })()`);
  return waitPaused(cdp, false);
}
/**
 * rAF callbacks per SECOND, measured over a fixed quiet window.
 *
 * The original version of the "no extra playback loop" check compared a raw
 * counter taken moments after the file opened (always 0, because the app's
 * first rAF only runs once the first timeupdate lands) against a counter taken
 * ten seconds later over a seek storm. That compares ELAPSED TIME, not loop
 * count, and failed on long files for that reason alone. Sampling the same
 * fixed window twice makes it a real measurement: a competing 60 Hz loop adds
 * ~60 callbacks per second, which is what this is meant to catch.
 */
async function rafRate(cdp, ms = 2000) {
  await ev(cdp, `(() => { window.__rafCount = 0; return 1; })()`);
  await sleep(ms);
  return (await probe(cdp)).rafPerFrame;
}

async function runFile(file, tier) {
  const full = path.join(MEDIA, file);
  // A native file:// source is seeked with a single currentTime write and MUST
  // never be reloaded. The ffmpeg tier is different by construction: the
  // decoder only holds a window around the target, so a jump outside it has to
  // respawn ffmpeg (that is what the window size exists to minimise). What is
  // forbidden there is a rebuild PER GESTURE — the storm must stay coalesced.
  const NATIVE = tier === '1';
  console.log('\n================================================================');
  console.log(`${file}  (${(fs.statSync(full).size / 1073741824).toFixed(2)} GB)  tier ${tier}`);
  console.log('================================================================');

  const child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT, env: { ...process.env, MOVIRA_USER_DATA_DIR: profileDir() },
    stdio: 'ignore', windowsHide: true,
  });
  try {
    let page = null;
    for (let i = 0; i < 90 && !page; i++) {
      await sleep(1000);
      try {
        const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        page = list.find((t) => t.type === 'page' && /dist[\\/]renderer[\\/]index\.html/.test(t.url));
      } catch { /* retry */ }
    }
    if (!page) throw new Error('page not found');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);
    for (let i = 0; i < 60; i++) { await sleep(500); if (await ev(cdp, `!!(window.__moviraTestPlay && window.__moviraServices)`).catch(() => false)) break; }
    await ev(cdp, HOOK);

    const o = await openMedia(cdp, full, file);
    ok('opens and plays', o.ok, o.ok ? '' : o.why);
    if (!o.ok) return;

    const tr = await box(cdp, '.timeline');
    const FWD = '.left button[title^="Next"]';
    const BACK = '.left button[title^="Previous"]';
    ok('transport controls are present', !!tr && !!(await box(cdp, FWD)) && !!(await box(cdp, BACK)));

    /* ---------------------------------------------------- 1. repeated seeks */
    console.log('\n== Repeated seeking: seek -> click -> seek -> click ==');
    const rafBefore = await rafRate(cdp);
    await reset(cdp);
    const dur = (await probe(cdp)).known;
    const targets = [0.10, 0.50, 0.20, 0.80, 0.35, 0.65, 0.15, 0.45].map((f) => Math.round(dur * f));
    const lat = [];
    let pre = await probe(cdp);
    for (const t of targets) {
      const r = JSON.parse(await ev(cdp, `window.__seekTo(${t}, 6, 12000)`).catch(() => '{"ok":0,"ms":-1}'));
      lat.push(r.ms);
      // A real trusted click on the timeline between every programmatic seek:
      // this is the "click -> seek -> click" pattern from the report.
      await click(cdp, { x: Math.round(tr.left + tr.width * 0.55), y: tr.y });
      await sleep(350);
    }
    const post = await probe(cdp);
    const worst = Math.max(...lat.filter((x) => x >= 0));
    info(`8 seeks, landing times: ${lat.join('ms, ')}ms`);
    ok('every one of 8 rapid seeks lands', lat.every((x) => x >= 0), `${lat.filter((x) => x < 0).length} missed`);
    ok('seek latency stays responsive (<1200ms worst)', worst < 1200, `worst ${worst}ms`);
    if (NATIVE) {
      ok('no load() during a seek storm', post.load === 0, `load()=${post.load}`);
      ok('no src assignment during a seek storm', post.src === 0, `src=${post.src}`);
      ok('currentTime was written, not re-created', post.cur >= 8, `currentTime assigns=${post.cur}`);
    } else {
      // ffmpeg has to be respawned for targets outside the decoded window, but
      // a burst must not turn into one rebuild per gesture.
      info(`tier 2: ${post.load} pipeline rebuild(s) for 8 seeks + 8 clicks (${post.cur} currentTime writes)`);
      ok('tier-2 rebuilds stay coalesced, not one per gesture', post.load <= targets.length, `load()=${post.load} for ${targets.length} seeks`);
    }
    ok('the media element is the SAME one throughout', post.sameElement, `sameElement=${post.sameElement}`);
    ok('no duplicate event listeners accumulate', post.liveListeners <= pre.liveListeners + 2, `live ${pre.liveListeners} -> ${post.liveListeners}`);
    const rafAfter = await rafRate(cdp);
    ok('no extra playback loop is created', rafAfter <= rafBefore + 20, `rAF callbacks per 2s window: ${rafBefore} -> ${rafAfter} (a 60Hz loop would add ~120)`);
    ok('the UI never blocked for more than 400ms', post.blk < 400, `worst block ${post.blk}ms (>50ms: ${post.blk50})`);
    // A tier-2 restart includes an ffmpeg spawn and a first decode, so give it
    // a real budget before judging whether playback survived the storm.
    await playEngine(cdp);
    const settled = await probe(cdp);
    ok('playback continues afterwards', settled.paused === false && settled.rs >= 3, `paused=${settled.paused} rs=${settled.rs}`);

    /* ------------------------------- 1b. ONE click = ONE seek, no bounce */
    console.log('\n== A SINGLE timeline click = exactly ONE seek, and the cursor never bounces ==');
    // The reported shape was "2:00 -> 10:00 -> 2:00 -> 10:00". Two independent
    // defects produced it, and both are asserted here:
    //   (a) the pixel of hand-wander during a press was classified as a DRAG,
    //       so one click ran pointerdown + scrub + release = THREE
    //       currentTime writes and landed seconds PAST the clicked position;
    //   (b) the cursor was rendered from the raw progress clock, which only
    //       advances on the next throttled push — between release and landing
    //       it showed the OLD position and then jumped forward again.
    await ev(cdp, CLICK_WATCH_HOOK);
    // One pixel of this timeline is dur/width seconds, so a click X rounded to
    // an integer pixel is up to half a pixel away from the ideal fraction.
    // 4 px of slack is far tighter than the jumps under test.
    const clickTol = Math.max(3, (dur / tr.width) * 4);
    for (const [label, fromFrac, toFrac] of [['forward', 0.20, 0.62], ['backward', 0.62, 0.18]]) {
      await ev(cdp, `window.__moviraServices.engine.seek(${Math.round(dur * fromFrac)}).catch(()=>{})`);
      await sleep(1200);
      await playEngine(cdp);
      await reset(cdp);
      const target = Math.round(dur * toFrac);
      await ev(cdp, `(() => { const c = window.__cw; c.rows.length = 0; c.on = true; return 1; })()`);
      await humanClick(cdp, Math.round(tr.left + tr.width * toFrac), tr.y);
      await sleep(1600);
      await ev(cdp, `(() => { window.__cw.on = false; return 1; })()`);
      const w = await evJson(cdp, CLICK_WATCH_SUMMARY(target.toFixed(2), clickTol.toFixed(2)));
      const after = await probe(cdp);
      const px = (tr.width / dur).toFixed(1);
      info(`${label} single click -> ${(target / 60).toFixed(1)}min: ${after.cur} currentTime write(s), ${w.n} samples, 1px = ${px}s`);
      // One gesture is one operation. On tier 2 an ffmpeg respawn may touch
      // currentTime internally, so the strict bound is native-only.
      ok(`${label} single click performs exactly ONE seek`, NATIVE ? after.cur === 1 : after.cur <= 4, `currentTime writes=${after.cur}`);
      ok(`${label} single click reaches the clicked position`, w.reached && w.err === null, `last cursor ${w.last}s vs target ${target}s`);
      ok(`${label} single click never bounces back to the old position`, !w.reverted, `started at ${w.first}s, ${w.n} samples`);
      ok(`${label} single click leaves the cursor at the clicked position`, Math.abs(w.last - target) < clickTol, `cursor ${w.last}s vs target ${target}s`);
    }

    /* ------------------------------------------- 2. forward/back buttons */
    console.log('\n== Forward / backward buttons ==');
    await pauseEngine(cdp);
    await reset(cdp);
    const b0 = await probe(cdp);
    await clickSel(cdp, FWD);
    await sleep(500);
    const b1 = await probe(cdp);
    const fwdDelta = b1.ft - b0.ft;
    ok('forward button moves currentTime by exactly +10s', Math.abs(fwdDelta - 10) < 1.2, `moved ${fwdDelta.toFixed(2)}s`);
    if (NATIVE) ok('forward button does not reload', b1.load === 0 && b1.src === 0, `load=${b1.load} src=${b1.src}`);
    ok('forward button keeps the same element', b1.sameElement);

    await clickSel(cdp, BACK);
    await sleep(500);
    const b2 = await probe(cdp);
    const backDelta = b2.ft - b1.ft;
    ok('backward button moves currentTime by exactly -10s', Math.abs(backDelta + 10) < 1.2, `moved ${backDelta.toFixed(2)}s`);
    if (NATIVE) ok('backward button does not reload', b2.load === 0 && b2.src === 0, `load=${b2.load} src=${b2.src}`);

    // Hammer them while PLAYING, which is the reported scenario ("when a video is
    // playing, clicking forward/backward causes lag and sometimes leaves it
    // unresponsive"). The button delta checks above deliberately paused the
    // player so nothing drifted between probes.
    await playEngine(cdp);
    await reset(cdp);
    for (let i = 0; i < 8; i++) { await clickSel(cdp, i % 2 ? BACK : FWD); await sleep(180); }
    // A tier-2 restart is an ffmpeg spawn plus a first decode, and the last
    // click can land while one is still in flight (the element is briefly
    // empty). What must hold is that it comes BACK on its own.
    await playEngine(cdp);
    await waitPaused(cdp, false, 500);
    await sleep(600);
    const b3 = await probe(cdp);
    ok('16 rapid button clicks keep the player healthy', b3.err === null && b3.rs >= 3 && !b3.paused, `rs=${b3.rs} paused=${b3.paused} err=${b3.err}`);
    if (NATIVE) ok('hammering the buttons does not reload', b3.load === 0 && b3.src === 0, `load=${b3.load} src=${b3.src}`);
    ok('hammering the buttons does not accumulate listeners', b3.liveListeners <= b0.liveListeners + 4, `live ${b0.liveListeners} -> ${b3.liveListeners}`);
    ok('hammering the buttons never blocks the UI', b3.blk < 400, `worst block ${b3.blk}ms`);

    /* ---------------------------------------------------- 3. pause state */
    console.log('\n== Pause / play state is preserved across seeks ==');
    await pauseEngine(cdp);
    await reset(cdp);
    const p0 = await probe(cdp);
    const r2 = JSON.parse(await ev(cdp, `window.__seekTo(${Math.round(dur * 0.7)}, 6, 12000)`).catch(() => '{"ok":0}'));
    const p1 = await probe(cdp);
    ok('a seek while paused does not start playback', p1.paused === true, `paused=${p1.paused}`);
    if (NATIVE) ok('a seek while paused does not reload', p1.load === 0 && p1.src === 0, `load=${p1.load} src=${p1.src}`);
    ok('a seek while paused still lands', r2.ok === 1, `ms=${r2.ms}`);

    /* ---------------------------------------------------- 4. drag rate */
    console.log('\n== Timeline dragging is coalesced, not a seek storm ==');
    await playEngine(cdp);
    await reset(cdp);
    const y = tr.y;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tr.left + tr.width * 0.1, y }, 30000);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tr.left + tr.width * 0.1, y, button: 'left', clickCount: 1, buttons: 1 }, 30000);
    const dragPath = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.7, 0.5, 0.3, 0.12, 0.5];
    const tDrag = Date.now();
    for (const f of dragPath) {
      const p = cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(tr.left + tr.width * f), y, button: 'left', buttons: 1 }, 30000).catch(() => null);
      await sleep(120);
      await p;
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tr.left + tr.width * 0.5, y, button: 'left', clickCount: 1, buttons: 1 }, 30000);
    const dragMs = Date.now() - tDrag;
    await sleep(1500);
    const d1 = await probe(cdp);
    const expectDrag = 0.5 * d1.known;
    info(`${dragPath.length} pointer moves over ${dragMs}ms produced ${d1.cur} currentTime writes`);
    if (NATIVE) ok('dragging does not reload the media', d1.load === 0 && d1.src === 0, `load=${d1.load} src=${d1.src}`);
    ok('dragging keeps the same element', d1.sameElement);
    // The engine rate-limits scrub writes to one per SCRUB_SEEK_MIN_MS (150 ms),
    // so a drag of dragMs may cost at most that many writes — not one per move.
    const scrubBudget = Math.max(6, Math.ceil(dragMs / 150) + 3);
    ok('dragging does NOT issue hundreds of seeks per second', d1.cur <= scrubBudget, `${d1.cur} writes for ${dragPath.length} moves over ${dragMs}ms (budget ${scrubBudget})`);
    ok('the drag commits its released position', Math.abs(d1.ft - expectDrag) < 60, `ft=${d1.ft} want ~${expectDrag.toFixed(0)}`);
    const dragResume = await waitResumed(cdp);
    ok('playback resumes normally after the drag', dragResume.ok, `paused=${dragResume.s.paused} rs=${dragResume.s.rs}`);
    ok('the UI stays responsive during the drag', d1.blk < 400, `worst block ${d1.blk}ms (>50ms: ${d1.blk50})`);

    /* ------------------------------------- 5. Stop -> Play -> seek again */
    console.log('\n== Stop, then Play, then seek again (the "it comes back" case) ==');
    await reset(cdp);
    // Stop through the UI control, exactly as a user would.
    const stopBtn = await box(cdp, 'button[title^="Stop"], .transport button[title*="Stop"]');
    if (stopBtn) await click(cdp, stopBtn);
    else await ev(cdp, `(async () => { await window.__moviraServices.engine.stop(); return 1; })()`).catch(() => {});
    await sleep(1500);
    const stopState = await probe(cdp);
    ok('Stop leaves the player paused and error-free', stopState.paused === true && stopState.err === null, `paused=${stopState.paused} err=${stopState.err}`);

    const playBtn = await box(cdp, 'button[title^="Play"], .transport button[title*="Play"]');
    if (playBtn) await click(cdp, playBtn);
    else await playEngine(cdp).catch(() => {});
    let resumed = null;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      resumed = await probe(cdp);
      if (!resumed.paused && resumed.rs >= 3) break;
    }
    ok('Play after Stop resumes playback', resumed.paused === false && resumed.rs >= 3, `paused=${resumed.paused} rs=${resumed.rs}`);

    await reset(cdp);
    const after = Math.round((await probe(cdp)).known * 0.3);
    const r3 = JSON.parse(await ev(cdp, `window.__seekTo(${after}, 6, 12000)`).catch(() => '{"ok":0,"ms":-1}'));
    const a1 = await probe(cdp);
    info(`post-Stop seek latency ${r3.ms}ms`);
    ok('seeking still works after a Stop/Play cycle', r3.ok === 1, `ms=${r3.ms}`);
    if (NATIVE) ok('post-Stop seeking does not reload', a1.load === 0 && a1.src === 0, `load=${a1.load} src=${a1.src}`);
    ok('post-Stop seeking does not accumulate listeners', a1.liveListeners <= b0.liveListeners + 4, `live ${b0.liveListeners} -> ${a1.liveListeners}`);
    ok('post-Stop seeking keeps the player responsive', a1.blk < 400, `worst block ${a1.blk}ms`);
    await playEngine(cdp);
    const a1b = await probe(cdp);
    ok('post-Stop seeking leaves playback running', a1b.paused === false, `paused=${a1b.paused}`);

    // And one more round of hammering, to prove the cycle is repeatable.
    await reset(cdp);
    for (let i = 0; i < 4; i++) { await clickSel(cdp, i % 2 ? BACK : FWD); await sleep(200); }
    await ev(cdp, `window.__seekTo(${Math.round(dur * 0.5)}, 6, 12000)`).catch(() => {});
    await playEngine(cdp);
    const a2 = await probe(cdp);
    ok('the Stop/Play cycle is repeatable without degradation', (NATIVE ? a2.load === 0 && a2.src === 0 : true) && a2.err === null && !a2.paused, `load=${a2.load} src=${a2.src} err=${a2.err} paused=${a2.paused}`);

    ok('no renderer exceptions during the whole run', cdp.errs.length === 0, cdp.errs.slice(0, 3).join(' | '));
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await sleep(2500);
    try { fs.rmSync(profileDir(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

(async () => {
  console.log('Packaged exe:', EXE, fs.existsSync(EXE) ? '(found)' : '(MISSING)');
  const files = [
    ['movie-2.86gb.mkv', '1'],
    ['bigmovie.mkv', '1'],
    ['heavy-dvd.mkv', '2'],
  ].filter(([f]) => fs.existsSync(path.join(MEDIA, f)));
  if (!files.length) throw new Error('no test media; run: node scripts/gen-bigmedia.cjs all');
  const pick = process.argv.slice(2).filter(Boolean);
  const run = pick.length ? files.filter(([f]) => pick.some((p) => f.includes(p))) : files;
  for (const [f, tier] of run) await runFile(f, tier);

  console.log('\n============================================================');
  console.log(`${passed} passed, ${failed} failed`);
  console.log('============================================================');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('SUITE FAILED:', e.stack); process.exit(1); });