/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * MOVIE-SCALE performance diagnostic against the PACKAGED binary.
 *
 * Everything the acceptance suite uses is a 240 s / 4 MB clip. That hides the
 * two things the user actually reports on a 2.86 GB MKV:
 *   1. LAG while playing -> main-thread starvation, so input queues behind it.
 *   2. Seeking forward/backward freezes -> the target is outside the decoded
 *      window, so the whole pipeline is torn down and rebuilt.
 *
 * WHY THE MEASUREMENT LIVES INSIDE THE PAGE
 * -----------------------------------------
 * The first version of this script polled the renderer over CDP and the
 * round-trip cost (~170 ms per poll) was larger than the events being
 * measured: it reported skips as failures and could not tell "the app was
 * busy" from "my probe was busy". A single `Input.dispatchMouseEvent`
 * even timed out. So all timing is now taken by code running in the page:
 *
 *   - `mark()`      : every gesture and every seek is stamped with
 *                     performance.now() at the exact moment it is issued.
 *   - `trace`       : a rAF sampler records (t, fileTime, readyState) so the
 *                     landing of a seek is read from a sample taken by the
 *                     page's OWN frame loop, not over the wire.
 *   - `block()`     : the worst single main-thread block, measured with a
 *                     0ms setTimeout ping. This is the direct, unambiguous
 *                     measure of "the app feels laggy": if a ping scheduled to
 *                     run in ~0ms actually runs 900ms later, the user is
 *                     staring at a frozen window.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Movira.exe');
const MEDIA = path.join(ROOT, 'testmedia');
const CDP_PORT = 9600 + (process.pid % 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = () => path.join(os.tmpdir(), `movira-perf-${process.pid}`);

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
async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('renderer: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const ev = (cdp, e) => evalJs(cdp, e);

// ---------------------------------------------------------------------------
// IN-PAGE INSTRUMENTATION. Installed once; survives file changes.
// ---------------------------------------------------------------------------
const HOOK = `(() => {
  const W = window;
  const eng = () => W.__moviraServices.engine;
  const now = () => performance.now();

  // ---- main-thread block detector -----------------------------------------
  // setTimeout(fn, 0) is the cheapest possible 'run as soon as the current task
  // ends' probe. If the observed delay greatly exceeds the requested one, the
  // main thread was blocked. This is the ground truth for UI responsiveness.
  W.__blk = { worst: 0, worstAt: 0, over50: 0, over200: 0, samples: 0, sum: 0 };
  let prevEnd = now();
  const ping = () => {
    const t = now();
    const gap = t - prevEnd;
    prevEnd = t + 1;
    setTimeout(ping, 1);
    // Ignore the first samples and gaps caused by the tab being backgrounded.
    if (W.__blk.samples > 20 && gap < 5000) {
      W.__blk.samples++;
      W.__blk.sum += gap;
      if (gap > W.__blk.worst) { W.__blk.worst = gap; W.__blk.worstAt = t; }
      if (gap > 50) W.__blk.over50++;
      if (gap > 200) W.__blk.over200++;
    }
  };
  setTimeout(ping, 1);

  // ---- long tasks ---------------------------------------------------------
  W.__lt = { long: 0, worst: 0, total: 0 };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        W.__lt.long++; W.__lt.total += e.duration;
        if (e.duration > W.__lt.worst) W.__lt.worst = e.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { W.__lt.err = String(e); }

  // ---- frame trace ---------------------------------------------------------
  // Sampled by the page's OWN rAF loop: when the app is responsive this runs at
  // ~60Hz; when it is starved the sample gaps grow, which is exactly the "lag"
  // the user describes.
  W.__trace = [];
  W.__marks = [];
  W.__rec = false;
  const tick = () => {
    if (W.__rec) {
      const v = document.querySelector('video');
      W.__trace.push([Math.round(now()), v ? +eng().currentFileTime().toFixed(3) : -1, v ? v.readyState : -1, v ? (v.paused ? 1 : 0) : -1]);
      if (W.__trace.length > 20000) W.__trace.shift();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  W.mark = (name, extra) => { W.__marks.push({ n: name, t: Math.round(now()), e: extra === undefined ? null : extra }); };
  W.startRec = () => { W.__trace.length = 0; W.__marks.length = 0; W.__rec = true; W.mark('rec-start'); };
  W.stopRec = () => { W.__rec = false; W.mark('rec-stop'); };

  // ---- gesture->landing measurement, entirely in-page ----------------------
  // Issues a seek and polls the page's own clock at rAF cadence, returning the
  // elapsed ms until the file clock is at the target. No CDP in the loop.
  W.seekLatency = (target, tol, budgetMs) => new Promise((resolve) => {
    const e = eng();
    const t0 = now();
    e.seek(target).catch(() => {});
    const samples = [];
    let last = -1;
    const step = () => {
      const ft = e.currentFileTime();
      samples.push([Math.round(now() - t0), +ft.toFixed(2), e.isFallbackBusy() ? 1 : 0]);
      if (Math.abs(ft - target) <= tol) return resolve(JSON.stringify({ ms: Math.round(now() - t0), ft: +ft.toFixed(2), ok: 1, samples: samples.slice(0, 12) }));
      if (now() - t0 > budgetMs) return resolve(JSON.stringify({ ms: -1, ft: +ft.toFixed(2), ok: 0, samples: samples.slice(0, 12) }));
      last = ft;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    void last;
  });

  // ---- element spies -------------------------------------------------------
  W.__sp = { load: 0, src: 0, cur: 0 };
  const P = HTMLMediaElement.prototype;
  const L = P.load;
  P.load = function () { W.__sp.load++; return L.call(this); };
  const ds = Object.getOwnPropertyDescriptor(P, 'src');
  Object.defineProperty(P, 'src', { get() { return ds.get.call(this); }, set(v) { W.__sp.src++; return ds.set.call(this, v); }, configurable: true });
  const dc = Object.getOwnPropertyDescriptor(P, 'currentTime');
  Object.defineProperty(P, 'currentTime', { get() { return dc.get.call(this); }, set(v) { W.__sp.cur++; return dc.set.call(this, v); }, configurable: true });

  return 'hooked';
})()`;

const SNAP = `(() => {
  const v = document.querySelector('video');
  const e = window.__moviraServices.engine;
  const d = window.__moviraMseDebug;
  const b = v ? v.buffered : null;
  const tr = window.__trace;
  // Frame-gap stats from the page's own sampler.
  let worstGap = 0, sum = 0, gaps = 0;
  for (let i = 1; i < tr.length; i++) { const g = tr[i][0] - tr[i-1][0]; if (g > 0 && g < 5000) { sum += g; gaps++; if (g > worstGap) worstGap = g; } }
  return JSON.stringify({
    ft: v ? +e.currentFileTime().toFixed(2) : -1,
    known: +e.knownDuration().toFixed(1),
    dur: v ? +(isFinite(v.duration) ? v.duration : -1).toFixed(1) : -1,
    rs: v ? v.readyState : -1, paused: v ? v.paused : null, err: v && v.error ? v.error.code : null,
    tier2: e.isFallbackBusy() ? 1 : 0,
    ahead: d ? +d.bufferedAheadSec().toFixed(1) : -1,
    bytes: d ? d.byteCount : -1, ranges: b ? b.length : -1,
    bufEnd: b && b.length ? +b.end(b.length - 1).toFixed(1) : 0,
    long: window.__lt.long, ltworst: Math.round(window.__lt.worst),
    blk: Math.round(window.__blk.worst), blk50: window.__blk.over50, blk200: window.__blk.over200, blkn: window.__blk.samples,
    avgFrame: gaps ? Math.round(sum / gaps) : -1, worstFrame: worstGap,
    load: window.__sp.load, src: window.__sp.src, cur: window.__sp.cur,
    heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1,
  });
})()`;
const snap = async (cdp) => JSON.parse(await ev(cdp, SNAP));
const resetMetrics = (cdp) => ev(cdp, `(() => {
  const b = window.__blk, l = window.__lt, s = window.__sp;
  b.worst = 0; b.over50 = 0; b.over200 = 0; b.samples = 0; b.sum = 0;
  l.long = 0; l.worst = 0; l.total = 0;
  s.load = 0; s.src = 0; s.cur = 0;
  window.__trace.length = 0; window.__rec = true;
  return 1;
})()`);
const stopRec = (cdp) => ev(cdp, `(() => { window.__rec = false; return 1; })()`);

async function box(cdp, sel) {
  return JSON.parse(await ev(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), width: Math.round(r.width) });
  })()`));
}
/** Trusted click; the timestamp is taken IN-PAGE by a rAF-scheduled stamp. */
async function click(cdp, b) {
  await ev(cdp, `new Promise(r => requestAnimationFrame(() => { window.mark('click'); r(1); }))`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y }, 20000);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 }, 20000);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 }, 20000);
}
/**
 * Real wheel: measures the delay until the page's OWN volume actually moves.
 *
 * The probe is ARMED and stored on window, and only then is the input
 * dispatched. Awaiting the probe before dispatching deadlocks: the promise
 * resolves on the volume change that only the wheel can cause.
 */
async function wheelLatency(cdp, x, y, deltaY) {
  await ev(cdp, `(() => {
    window.__wheel = new Promise((res) => {
      const v = document.querySelector('video');
      const before = v.volume;
      let t0 = 0;
      const check = () => {
        if (!t0) t0 = performance.now();
        if (v.volume !== before) return res(JSON.stringify({ ms: Math.round(performance.now() - t0), delta: +(v.volume - before).toFixed(3) }));
        if (performance.now() - t0 > 4000) return res(JSON.stringify({ ms: -1, delta: +(v.volume - before).toFixed(3) }));
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    return 1;
  })()`).catch(() => {});
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, 20000).catch(() => {});
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, pointerType: 'mouse' }, 20000)
    .catch((e) => console.log('     [wheel dispatch failed: ' + e.message + ']'));
  const r = await ev(cdp, 'window.__wheel').catch((e) => JSON.stringify({ ms: -1, delta: 0, err: e.message }));
  return typeof r === 'string' ? JSON.parse(r) : r;
}

/**
 * Open a file and wait for real playback.
 *
 * A file Chromium cannot decode ALWAYS reports error 4 first: that is the
 * native tier failing, and the engine then escalates to the ffmpeg -> MSE tier.
 * So a single error sample is NOT a failure — only an error that persists for
 * several seconds (across the escalation window) is. The previous version
 * returned on the first error and reported working tier-2 files as broken.
 */
async function open(cdp, file, title) {
  const t0 = Date.now();
  await ev(cdp, `(() => { window.__moviraTestPlay([{ id: 'p', type: 'video', title: ${JSON.stringify(title)}, path: ${JSON.stringify(file)} }], 0); return 1; })()`);
  let firstErrAt = 0;
  for (let i = 0; i < 480; i++) {
    await sleep(250);
    const s = JSON.parse(await ev(cdp, `(() => { const v=document.querySelector('video'); return JSON.stringify({ rs: v?v.readyState:-1, p: v?v.paused:null, e: v&&v.error?v.error.code:null }); })()`).catch(() => '{"rs":-1}'));
    if (s.rs >= 3 && s.p === false) return { ok: true, ms: Date.now() - t0, escalated: !!firstErrAt };
    if (s.e) {
      if (!firstErrAt) firstErrAt = Date.now();
      // Native tier gave up 15s ago and the fallback has not started: give up.
      else if (Date.now() - firstErrAt > 15000) return { ok: false, err: 'error code ' + s.e + ' persisting ' + (Date.now() - firstErrAt) + 'ms', ms: Date.now() - t0 };
    }
  }
  return { ok: false, err: 'timeout', ms: Date.now() - t0 };
}

const V = (ok, warn) => (ok ? 'PASS' : warn ? 'WARN' : 'FAIL');
// Hard assertions: these fail the run instead of merely printing a colour, so
// a regression in seek behaviour cannot hide behind a diagnostic script.
let hardPass = 0;
let hardFail = 0;
const ok = (cond, msg) => {
  if (cond) { hardPass++; console.log('  PASS ' + msg); }
  else { hardFail++; console.log('  FAIL ' + msg); }
};

/**
 * Run ONE file in a FRESH app process.
 *
 * Measuring several movies inside one app instance produced garbage: after the
 * first file the renderer's rAF sampler went silent and wheel dispatches took
 * 40 s, yet the same file measured perfectly in a fresh process, and a direct
 * rAF probe in that state showed a healthy 60 Hz loop. That is harness state
 * bleeding between scenarios, not an app defect. One process per file is both
 * the trustworthy measurement and the realistic one (a user watches one movie
 * at a time), and it keeps the single-instance lock out of the picture.
 */
async function runOne([file, desc]) {
  // An absolute path is used verbatim so the diagnostic can be pointed at a
  // REAL user file, not only the synthesized stand-ins in testmedia/.
  const full = path.isAbsolute(file) ? file : path.join(MEDIA, file);
  if (!fs.existsSync(full)) throw new Error(`file not found: ${full}`);
  console.log('================================================================');
  console.log(`${file}  (${(fs.statSync(full).size / 1073741824).toFixed(2)} GB)  ${desc}`);
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
    if (!page) throw new Error('packaged app page not found');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) { await sleep(500); ready = await ev(cdp, `!!(window.__moviraTestPlay && window.__moviraServices)`).catch(() => false); }
    if (!ready) throw new Error('renderer never became ready');
    await ev(cdp, HOOK);

    const o = await open(cdp, full, file);
    console.log(`  open -> playing in ${o.ms}ms${o.escalated ? ' (native tier failed first, escalated to ffmpeg->MSE)' : ''}  ${o.ok ? V(true) : V(false) + ' *** ' + o.err + ' ***'}`);
    if (!o.ok) return;
    let s = await snap(cdp);
    console.log(`  duration: element=${s.dur}s engine=${s.known}s  tier2=${s.tier2}  bufferedRanges=${s.ranges}`);
    console.log(s.tier2
      ? '  (tier 2: ffmpeg -> fragmented MP4 -> MSE; the forward window governs seek cost)'
      : '  (native tier: Chromium decodes this itself, no MSE pipeline in the way)');

    // ---------------------------- steady playback ----------------------------
    await resetMetrics(cdp);
    await sleep(20000);
    await stopRec(cdp);
    s = await snap(cdp);
    console.log('\n  [playback 20 s]');
    console.log(`     main-thread worst block : ${s.blk}ms   (>50ms: ${s.blk50}, >200ms: ${s.blk200})  ${V(s.blk < 120, s.blk < 300)}`);
    console.log(`     long tasks              : ${s.long} worst ${s.ltworst}ms  ${V(s.ltworst < 120, s.ltworst < 300)}`);
    console.log(`     frame gap avg/worst      : ${s.avgFrame}ms / ${s.worstFrame}ms  ${V(s.worstFrame < 120, s.worstFrame < 350)}`);
    console.log(`     advanced                 : ${s.ft.toFixed(1)}s  rs=${s.rs} paused=${s.paused} err=${s.err}`);
    console.log(`     buffered ranges=${s.ranges}  ahead=${s.ahead}s  heap=${s.heap}MB`);
    if (s.ranges > 4) console.log('     *** MANY DISJOINT RANGES: memory fragmenting ***');

    // -------------------------- input responsiveness --------------------------
    const vc = await box(cdp, 'video');
    await ev(cdp, `(() => { const v=document.querySelector('video'); v.muted=false; v.volume=0.5; return 1; })()`);
    await sleep(400);
    const w1 = await wheelLatency(cdp, vc.x, vc.y, -120);
    console.log(`\n  [wheel over video, playing] delta=${w1.delta} applied in ${w1.ms}ms${w1.err ? ' ERR=' + w1.err : ''}  ${V(w1.ms >= 0 && w1.ms < 300, w1.ms < 700)}`);

    // ------------------ skip fwd / back (trusted clicks on the real button) ----
    const fwd = await box(cdp, '.left button[title^="Next"]');
    const back = await box(cdp, '.left button[title^="Previous"]');
    for (const [label, b, sign] of [['skip FWD', fwd, 1], ['skip BACK', back, -1]]) {
      if (!b || b === 'null' || !b.w) { console.log(`\n  [${label}] BUTTON NOT FOUND`); continue; }
      const dur = (await snap(cdp)).known;
      await ev(cdp, `(() => { window.__moviraServices.engine.seek(${Math.round(dur / 2)}); return 1; })()`);
      await sleep(3000);
      // The watcher samples 'before' on the frame the click lands, not at arm
      // time: arming happens before two dispatch round trips and the video
      // keeps playing in between, which made every skip look like a miss.
      await ev(cdp, `(() => {
        window.__arm = new Promise((resolve) => {
          const e = window.__moviraServices.engine;
          let t0 = 0, before = 0, target = 0;
          const path = [];
          const watch = () => {
            const ft = e.currentFileTime();
            if (!t0) { t0 = performance.now(); before = ft; target = before + ${sign} * 10; path.push([0, +ft.toFixed(2)]); }
            else path.push([Math.round(performance.now() - t0), +ft.toFixed(2)]);
            if (t0 && Math.abs(ft - target) <= 4) {
              return resolve(JSON.stringify({ before: +before.toFixed(2), target: +target.toFixed(2), ft: +ft.toFixed(2), ms: Math.round(performance.now() - t0), ok: 1, path: path.slice(0, 10) }));
            }
            if (t0 && performance.now() - t0 > 6000) {
              return resolve(JSON.stringify({ before: +before.toFixed(2), target: +target.toFixed(2), ft: +ft.toFixed(2), ms: -1, ok: 0, path: path.slice(0, 10) }));
            }
            requestAnimationFrame(watch);
          };
          requestAnimationFrame(watch);
        });
        return 1;
      })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y }, 20000);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 }, 20000);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 }, 20000);
      const res = JSON.parse(await ev(cdp, 'window.__arm').catch((e) => JSON.stringify({ ok: 0, ms: -1, err: e.message })));
      const after = await snap(cdp);
      if (res.err) console.log(`\n  [${label}] HARNESS ERROR: ${res.err}`);
      console.log(`\n  [${label}] ${res.before}s -> ${res.ft !== undefined ? res.ft + 's' : '?'} (want ~${res.target})  ${res.ok ? res.ms + 'ms' : '*** NEVER LANDED ***'}  ${V(!!res.ok && res.ms < 1200, !!res.ok && res.ms < 3000)}`);
      console.log(`     first samples [ms, fileTime]: ${JSON.stringify(res.path || [])}`);
      console.log(`     currentTime assigns=${after.cur}  load()=${after.load}  src=${after.src}  ${after.load || after.src ? '*** RELOADED ***' : '(no reload, correct)'}`);
      console.log(`     worst block during=${after.blk}ms  longtask worst=${after.ltworst}ms  frame worst=${after.worstFrame}ms  ahead=${after.ahead}s`);
      await resetMetrics(cdp);
    }

    // ---------------- scrub drag forward then backward ----------------
    // "Seeking while moving forward and backward" read literally: dragging the
    // timeline thumb. A real pointer drag, out to 85% and back to 15%.
    const tr = await box(cdp, '.timeline');
    if (tr && tr !== 'null' && tr.width > 50) {
      await ev(cdp, `(() => { window.__moviraServices.engine.seek(60); return 1; })()`);
      await sleep(2500);
      await resetMetrics(cdp);
      const y = tr.y;
      const path = [0.15, 0.4, 0.65, 0.85, 0.6, 0.35, 0.15, 0.5];
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tr.left + tr.width * 0.1, y }, 20000);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tr.left + tr.width * 0.1, y, button: 'left', clickCount: 1, buttons: 1 }, 20000);
      const t0 = Date.now();
      let stall = 0;
      for (const f of path) {
        const x = Math.round(tr.left + tr.width * f);
        const p = cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }, 20000).catch(() => null);
        await sleep(140); // a realistic human drag: ~7 moves/sec
        await p;
        stall = Math.max(stall, Date.now() - t0);
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tr.left + tr.width * 0.5, y, button: 'left', clickCount: 1, buttons: 1 }, 20000);
      const dragWall = Date.now() - t0;
      await sleep(2500);
      const post = await snap(cdp);
      const expect = 0.5 * post.known;
      console.log(`\n  [scrub drag: 8 moves out to 85% and back to 15%, released at 50%]`);
      console.log(`     ${dragWall}ms for 8 moves (a human drag is ~1100ms)  dispatched-without-stall ${stall}ms`);
      console.log(`     landed at ${post.ft}s (want ~${expect.toFixed(0)}s)  ${Math.abs(post.ft - expect) < 60 ? V(true) : V(false) + ' *** WRONG POSITION ***'}`);
      console.log(`     worst main-thread block during drag: ${post.blk}ms  >50ms: ${post.blk50}  >200ms: ${post.blk200}  ${V(post.blk < 120, post.blk < 350)}`);
      console.log(`     long tasks ${post.long} worst ${post.ltworst}ms  frame gap avg/worst ${post.avgFrame}/${post.worstFrame}ms`);
      console.log(`     load()=${post.load} src=${post.src}  ${post.load || post.src ? '*** RELOADED ***' : '(no reload, correct)'}`);
      await resetMetrics(cdp);
    } else {
      console.log('\n  [scrub drag] TIMELINE NOT FOUND');
    }

    // ---------------- big jumps across the whole timeline ----------------
    const dur = (await snap(cdp)).known;
    for (const frac of [0.8, 0.05, 0.5, 0.95]) {
      const target = Math.round(dur * frac);
      const r = JSON.parse(await ev(cdp, `window.seekLatency(${target}, 5, 12000)`).catch((e) => JSON.stringify({ ok: 0, ms: -1, err: e.message })));
      const s2 = await snap(cdp);
      console.log(`\n  [jump to ${target}s (${(frac * 100).toFixed(0)}%)] ${r.ok ? 'landed in ' + r.ms + 'ms' : '*** DID NOT LAND (ft=' + r.ft + ') ***'}  ${V(!!r.ok && r.ms < 1500, !!r.ok && r.ms < 4000)}`);
      console.log(`     load()=${s2.load} src=${s2.src}  worstBlock=${s2.blk}ms  tier2=${s2.tier2} ahead=${s2.ahead}s ranges=${s2.ranges}`);
      if (s2.load || s2.src) console.log('     *** a plain in-file jump reloaded the media ***');
      await resetMetrics(cdp);
    }

    // ======================= SEEK STRESS (real user file) ==================
    // Everything above is a polite, well-separated gesture. A real user
    // "clicking different positions repeatedly" produces a DENSE burst: a
    // ~120 move drag inside one second, and click-after-click with no pause.
    // If seek handling is not coalesced this is where it shows up.
    if (process.env.MOVIRA_STRESS === '1') {
      const trS = await box(cdp, '.timeline');
      if (trS && trS !== 'null' && trS.width > 50) {
        // --- dense human drag: 120 moves in ~1.2 s, right-to-left then back
        await ev(cdp, `(() => { window.__moviraServices.engine.seek(60); return 1; })()`);
        await sleep(2500);
        await resetMetrics(cdp);
        const yS = trS.y, x0 = trS.left, wid = trS.width;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x0 + wid * 0.5), y: yS, button: 'none', buttons: 0 }, 20000);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x0 + wid * 0.5), y: yS, button: 'left', clickCount: 1, buttons: 1 }, 20000);
        const tDrag = Date.now();
        let moved = 0;
        for (let i = 0; i <= 120; i++) {
          const f = i / 120;
          const x = Math.round(x0 + wid * (0.5 + 0.45 * Math.sin(f * Math.PI * 2)));
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: yS, button: 'left', buttons: 1 }, 20000).catch(() => {});
          moved++;
        }
        const dMs = Date.now() - tDrag;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x0 + wid * 0.5), y: yS, button: 'left', clickCount: 1, buttons: 0 }, 20000);
        await sleep(1500);
        const ds = await snap(cdp);
        console.log(`\n  [STRESS dense drag] ${moved} pointer moves in ${dMs}ms  ${V(dMs < 9000, true)}`);
        // Spec: dragging "should not cause hundreds of seek operations per
        // second" and must not "continuously assign currentTime". The element
        // is rate-limited, so a long drag must cost a small, bounded number of
        // writes rather than one per move.
        const writeBudget = Math.max(6, Math.ceil(dMs / 150) + 3);
        ok(ds.cur <= writeBudget, `currentTime writes=${ds.cur} within budget ${writeBudget} for ${moved} moves`);
        console.log(`     currentTime writes=${ds.cur} (budget ${writeBudget})  load()=${ds.load}  src=${ds.src}  ${ds.load || ds.src ? '*** RELOADED ***' : '(no reload, correct)'}`);
        console.log(`     worst block=${ds.blk}ms  >50ms:${ds.blk50}  >200ms:${ds.blk200}  longtask worst=${ds.ltworst}ms  frame worst=${ds.worstFrame}ms  ${V(ds.blk < 200, ds.blk < 600)}`);

        // --- click storm: 25 real trusted clicks at scattered positions
        await resetMetrics(cdp);
        const durS = (await snap(cdp)).known;
        const tC = Date.now();
        let landed = 0;
        for (let i = 0; i < 25; i++) {
          const f = ((i * 37) % 100) / 100;
          const x = Math.round(x0 + wid * (0.02 + 0.96 * f));
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: yS }, 20000).catch(() => {});
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: yS, button: 'left', clickCount: 1, buttons: 1 }, 20000).catch(() => {});
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: yS, button: 'left', clickCount: 1, buttons: 0 }, 20000).catch(() => {});
          const want = durS * f;
          // Wait for the seek to LAND before sampling. Sampling immediately
          // after the dispatch reads a mid-seek position and reports a miss
          // that never happened.
          await sleep(260);
          const got = (await snap(cdp)).ft;
          if (Math.abs(got - want) < durS * 0.03) landed++;
        }
        const cMs = Date.now() - tC;
        const cs = await snap(cdp);
        console.log(`\n  [STRESS click storm] 25 clicks in ${cMs}ms, ${landed}/25 landed near target  ${V(landed >= 22, landed >= 15)}`);
        console.log(`     worst block=${cs.blk}ms  >50ms:${cs.blk50}  >200ms:${cs.blk200}  longtask worst=${cs.ltworst}ms  frame worst=${cs.worstFrame}ms  ${V(cs.blk < 200, cs.blk < 600)}`);
        console.log(`     currentTime writes=${cs.cur}  load()=${cs.load}  src=${cs.src}  ${cs.load || cs.src ? '*** RELOADED ***' : '(no reload, correct)'}`);

        // --- skip-button burst: 20 alternating real clicks
        const bf = await box(cdp, '.left button[title^="Next"]');
        const bb = await box(cdp, '.left button[title^="Previous"]');
        if (bf && bf !== 'null' && bf.w && bb && bb !== 'null' && bb.w) {
          await resetMetrics(cdp);
          const beforeB = (await snap(cdp)).ft;
          for (let i = 0; i < 20; i++) {
            const b = i % 2 ? bb : bf;
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y }, 20000).catch(() => {});
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 }, 20000).catch(() => {});
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0 }, 20000).catch(() => {});
            await sleep(90);
          }
          await sleep(1200);
          const bs = await snap(cdp);
          const drift = Math.abs(bs.ft - (beforeB + (10 - 10)));
          console.log(`\n  [STRESS skip burst] 20 alternating F/B clicks, net drift ${drift.toFixed(2)}s (want ~0)  ${V(drift < 6, drift < 20)}`);
          console.log(`     worst block=${bs.blk}ms  >50ms:${bs.blk50}  >200ms:${bs.blk200}  longtask worst=${bs.ltworst}ms  ${V(bs.blk < 200, bs.blk < 600)}`);
          console.log(`     currentTime writes=${bs.cur}  load()=${bs.load}  src=${bs.src}  ${bs.load || bs.src ? '*** RELOADED ***' : '(no reload, correct)'}`);
        }

        // --- Stop -> Play -> seek, repeated.
        // Reported as "clicking Stop and then starting playback again can bring
        // the seeking/lagging problem back", so the thing that matters is the
        // seek AFTER a restart, on a long file, done several times over.
        for (let cyc = 1; cyc <= 3; cyc++) {
          await ev(cdp, `(() => { window.__moviraServices.engine.stop(); return 1; })()`).catch(() => {});
          await sleep(1500);
          const re = await open(cdp, full, file);
          if (!re.ok) { console.log(`\n  [STRESS stop/play cycle ${cyc}] REOPEN FAILED: ${re.err}`); break; }
          await resetMetrics(cdp);
          const targets = [durS * 0.7, durS * 0.2, durS * 0.9];
          const tgt = targets[cyc - 1];
          const r = JSON.parse(await ev(cdp, `window.seekLatency(${tgt}, 1.5, 8000)`).catch((e) => JSON.stringify({ ms: -1, ok: 0, err: e.message })));
          const cs2 = await snap(cdp);
          console.log(`\n  [STRESS stop/play cycle ${cyc}] reopened in ${re.ms}ms, seek to ${Math.round(tgt)}s landed in ${r.ms}ms  ${V(!!r.ok && r.ms < 1500, !!r.ok && r.ms < 5000)}`);
          console.log(`     worst block=${cs2.blk}ms  >50ms:${cs2.blk50}  >200ms:${cs2.blk200}  longtask worst=${cs2.ltworst}ms  frame worst=${cs2.worstFrame}ms  ${V(cs2.blk < 200, cs2.blk < 600)}`);
          console.log(`     post-restart: currentTime writes=${cs2.cur}  load()=${cs2.load}  src=${cs2.src}  rs=${cs2.rs} paused=${cs2.paused} err=${cs2.err} heap=${cs2.heap}MB  ${cs2.src ? '*** SRC CHANGED ***' : '(src stable, correct)'}`);
        }
      }
    }

    // ---------------------------- still alive? ----------------------------
    const a = (await snap(cdp)).ft;
    await sleep(6000);
    const b2 = await snap(cdp);
    console.log(`\n  [after all seeks] advanced ${(b2.ft - a).toFixed(2)}s in 6s  ${V(b2.ft - a > 3.5, b2.ft - a > 1.5)}`);
    console.log(`     rs=${b2.rs} paused=${b2.paused} err=${b2.err} heap=${b2.heap}MB ranges=${b2.ranges} ahead=${b2.ahead}s`);
    const vc2 = await box(cdp, 'video');
    await ev(cdp, `(() => { const v=document.querySelector('video'); v.volume=0.5; return 1; })()`);
    const w2 = await wheelLatency(cdp, vc2.x, vc2.y, -120);
    console.log(`     wheel still live: delta=${w2.delta} in ${w2.ms}ms  ${V(w2.ms >= 0 && w2.ms < 400, w2.ms < 900)}`);
    console.log('  renderer exceptions: ' + (cdp.errs.length ? cdp.errs.slice(0, 4).join(' | ') : '(none)'));
    console.log('');
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await sleep(2500);
    try { fs.rmSync(profileDir(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function main() {
  console.log('Packaged exe:', EXE, fs.existsSync(EXE) ? '(found)' : '(MISSING)');
  const ALL = [
    ['movie-2.86gb.mkv', 'the reported file: 2.7 GB, 80 min, H.264/AAC'],
    ['bigmovie.mkv', '5.1 GB, 150 min, H.264/AAC'],
    ['heavy-dvd.mkv', '0.8 GB, 20 min, mpeg2video + AC3 5.1 (tier-2 ffmpeg->MSE)'],
  ].filter(([f]) => fs.existsSync(path.join(MEDIA, f)));
  const pick = process.argv.slice(2).filter(Boolean);
  // Absolute path  -> measure that exact file (the user's own movie).
  // Otherwise     -> substring-filter the bundled test media.
  const cands = pick.length
    ? pick.some((p) => path.isAbsolute(p))
      ? pick.map((p) => [p, 'REAL USER FILE'])
      : ALL.filter(([f]) => pick.some((q) => f.includes(q)))
    : ALL;
  if (!cands.length) throw new Error('no matching test media; run: node scripts/gen-bigmedia.cjs all');
  for (const one of cands) await runOne(one);
}

main().then(() => process.exit(0)).catch((e) => { console.error('DIAG FAILED:', e.stack); process.exit(1); });