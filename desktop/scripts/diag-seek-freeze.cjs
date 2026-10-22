/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * SEEK-THAW DIAGNOSTIC: how long is the PICTURE frozen after a timeline click?
 *
 * The timeline reaching the right position proves nothing about playback. "Frozen
 * for 1-2 seconds" is a claim about PRESENTED FRAMES, not about currentTime, so
 * this measures the one thing that cannot lie:
 *
 *   video.requestVideoFrameCallback() fires once per frame the compositor
 *   actually DISPLAYS. A gap between two consecutive callbacks IS the freeze,
 *   stamped by the page's own clock — never measured over CDP.
 *
 * Around each click it also records every media event with the element's state
 * at that instant (readyState, paused, buffered ahead) plus a 100 ms sampler.
 * That is what makes the freeze attributable: an element pinned at readyState
 * 1/2 is starved, an element at readyState 4 with paused=true is a pause bug,
 * and readyState 4 + playing + still no frames is a present/decoder problem.
 * A spy on pause()/play()/load() with stack traces rules the pause bugs out
 * explicitly rather than by assumption.
 *
 * MEASUREMENT CORRECTNESS NOTES (both bugs were found and fixed here):
 *   - rVFC silently stops while the element presents nothing, which is exactly
 *     the state under test, so a pure rVFC chain dies on the first freeze. It is
 *     re-armed from a timer, but ONLY when the chain has gone stale, otherwise
 *     every re-arm spawns another chain and the sample rate multiplies.
 *   - `presentedFrames` is monotonic, so frames are de-duplicated by it. A
 *     duplicated callback cannot inflate the count or invent a fake gap.
 *   - Offsets are anchored to the CLICK, not to the first captured frame: on a
 *     fast seek that frame is already post-seek, which made every earlier event
 *     print with a negative offset and hid the real duration.
 *
 * Usage: node scripts/diag-seek-freeze.cjs [media-file ...]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Movira.exe');
const MEDIA = path.join(ROOT, 'testmedia');
const CDP_PORT = 9500 + (process.pid % 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = () => path.join(os.tmpdir(), `movira-thaw-${process.pid}`);

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
async function ev(cdp, e) {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('renderer: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const evJson = async (cdp, e) => JSON.parse(await ev(cdp, e));
const hhmmss = (s) => {
  if (!isFinite(s) || s < 0) return '??:??';
  const t = Math.round(s);
  const hh = Math.floor(t / 3600); const mm = Math.floor((t % 3600) / 60); const ss = t % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};

const HOOK = `(() => {
  const W = window;
  if (W.__th) return 'already';
  const v = document.querySelector('video');
  if (!v) return 'no video';
  const now = () => performance.now();
  const snap = () => {
    let ahead = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.25 && v.buffered.end(i) >= v.currentTime) { ahead = v.buffered.end(i) - v.currentTime; break; }
    }
    return { ct: +v.currentTime.toFixed(2), rs: v.readyState, ns: v.networkState, paused: v.paused, ahead: +ahead.toFixed(2), seeking: v.seeking };
  };
  W.__th = { on: false, t0: 0, frames: [], events: [], samples: [], calls: [],
             rvfc: false, hasRvfc: typeof v.requestVideoFrameCallback === 'function' };

  // ---- PRESENTED FRAMES ----------------------------------------------------
  if (W.__th.hasRvfc) {
    let lastStepAt = 0;
    let lastPresented = -1;
    const step = (nowTs, meta) => {
      lastStepAt = performance.now();
      try {
        // presentedFrames is monotonic: duplicates (a stale re-arm firing the
        // same frame twice) can neither inflate the count nor invent a gap.
        if (W.__th.on && meta.presentedFrames !== lastPresented) {
          lastPresented = meta.presentedFrames;
          W.__th.frames.push([Math.round(nowTs), +meta.mediaTime.toFixed(3), meta.presentedFrames]);
          if (W.__th.frames.length > 6000) W.__th.frames.shift();
        }
      } catch (e) { W.__th.err = String(e); }
      try { v.requestVideoFrameCallback(step); } catch (e) { /* chain will be re-armed */ }
    };
    try { v.requestVideoFrameCallback(step); W.__th.rvfc = true; } catch (e) { W.__th.rvfc = false; }
    // Re-arm ONLY a chain that has gone stale. Unconditional re-arming spawns a
    // new chain every tick and the sample rate multiplies without bound.
    setInterval(() => {
      if (performance.now() - lastStepAt > 400) {
        try { v.requestVideoFrameCallback(step); lastStepAt = performance.now(); } catch (e) { /* pending */ }
      }
    }, 200);
  }

  // ---- pause()/play()/load() with stacks: rules out a real PAUSE bug --------
  if (!W.__th.spyInstalled) {
    W.__th.spyInstalled = true;
    const P = HTMLMediaElement.prototype;
    for (const m of ['pause', 'play', 'load']) {
      const orig = P[m];
      P[m] = function (...a) {
        if (W.__th.on) {
          const st = String(new Error().stack || '').split('\\n').slice(1, 5).join(' | ').slice(0, 240);
          W.__th.calls.push([Math.round(now()), m, st]);
        }
        return orig.apply(this, a);
      };
    }
  }

  for (const type of ['seeking', 'seeked', 'waiting', 'playing', 'canplay', 'canplaythrough', 'pause', 'play',
                      'stalled', 'suspend', 'emptied', 'ratechange', 'loadedmetadata', 'error']) {
    v.addEventListener(type, () => {
      if (!W.__th.on) return;
      const s = snap();
      W.__th.events.push([Math.round(now()), type, s.ct, s.rs, s.paused ? 1 : 0, s.ahead, s.seeking ? 1 : 0]);
    });
  }

  const sample = () => {
    if (!W.__th.on) return;
    const s = snap();
    W.__th.samples.push([Math.round(now()), s.ct, s.rs, s.paused ? 1 : 0, s.ahead, s.seeking ? 1 : 0]);
    if (W.__th.samples.length > 2000) W.__th.samples.shift();
  };
  setInterval(sample, 100);
  return 'hooked';
})()`;

/**
 * Is the window actually LIVE? An occluded/unfocused Electron window has rAF
 * AND video presentation throttled to ~1 Hz, which reads as a multi-second
 * "freeze" that no user would ever see — it produced a bogus 916 ms stall in
 * the first version of this script. Every measurement is therefore gated on
 * this: below ~30 rAF frames/second the numbers are meaningless and reported as
 * such rather than as a defect.
 */
async function liveness(cdp) {
  const r = await evJson(cdp, `new Promise((res) => {
    let n = 0;
    const t0 = performance.now();
    const step = () => {
      n++;
      if (performance.now() - t0 < 1000) requestAnimationFrame(step);
      else res(JSON.stringify({ fps: Math.round(n / ((performance.now() - t0) / 1000)), vis: document.visibilityState, hidden: document.hidden }));
    };
    requestAnimationFrame(step);
  })`);
  return r;
}

async function trackBox(cdp) {
  return evJson(cdp, `JSON.stringify((() => {
    const el = document.querySelector('.timeline');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, width: r.width, y: Math.round(r.top + r.height / 2), dur: window.__moviraServices.engine.knownDuration() };
  })())`);
}

/** Stamps the click moment in the page's clock, then clicks like a human:
 *  button held ~120 ms, hand wandering a pixel before release. */
async function humanClick(cdp, x, y) {
  await ev(cdp, `(() => { window.__th.clickAt = Math.round(performance.now()); return 1; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, 30000);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }, 30000);
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 1, y, button: 'left', buttons: 1 }, 30000).catch(() => {});
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 1, y, button: 'left', clickCount: 1, buttons: 0 }, 30000);
}

async function trial(cdp, box, fromFrac, toFrac, label) {
  await ev(cdp, `window.__moviraServices.engine.seek(${Math.round(box.dur * fromFrac)}).catch(()=>{})`);
  await sleep(1800);
  const target = Math.round(box.dur * toFrac);
  await ev(cdp, `(() => { const t = window.__th; t.frames.length = 0; t.events.length = 0; t.samples.length = 0; t.calls.length = 0; t.t0 = Math.round(performance.now()); t.on = true; return 1; })()`);
  await humanClick(cdp, Math.round(box.left + box.width * toFrac), box.y);
  await sleep(4000);
  await ev(cdp, `(() => { window.__th.on = false; return 1; })()`);
  const d = await evJson(cdp, `JSON.stringify({
    rvfc: window.__th.rvfc, err: window.__th.err || null, t0: window.__th.t0,
    clickAt: window.__th.clickAt || 0,
    frames: window.__th.frames, events: window.__th.events, samples: window.__th.samples, calls: window.__th.calls,
  })`);
  const t0 = d.t0;
  const rel = (t) => `+${String(t - t0).padStart(5)}ms`;

  console.log(`\n  --- ${label}: ${hhmmss(Math.round(box.dur * fromFrac))} -> click ${hhmmss(target)} ---`);
  if (!d.rvfc) { console.log('     requestVideoFrameCallback unavailable'); return { freeze: -1 }; }
  const F = d.frames;
  const E = d.events;
  const seekEv = E.find((e) => e[1] === 'seeking');
  const seekedEv = E.find((e) => e[1] === 'seeked');
  const seekMs = seekEv && seekedEv ? seekedEv[0] - seekEv[0] : -1;

  // THE NUMBER. rVFC firing does NOT mean the picture changed: while the
  // element is starved it happily keeps re-presenting the LAST decoded frame,
  // so a "presented frame" rate looks perfectly healthy through a freeze. The
  // thing the user sees is only ADVANCE, so only frames whose mediaTime
  // actually moved are counted. This was a real measurement bug — the first
  // version reported an 84 ms stall while the click-to-first-new-frame distance
  // was 443 ms, precisely because the frozen frames were counted as progress.
  const A = F.filter((f, i) => i === 0 || Math.abs(f[1] - F[i - 1][1]) > 0.001);
  let freeze = 0, at = 0;
  for (let i = 1; i < A.length; i++) {
    const g = A[i][0] - A[i - 1][0];
    if (g > freeze) { freeze = g; at = A[i - 1][0]; }
  }
  // Steady-state picture-advance gap, for scale.
  const steady = [];
  for (let i = 1; i < A.length; i++) steady.push(A[i][0] - A[i - 1][0]);
  steady.sort((a, b) => a - b);
  const median = steady.length ? steady[Math.floor(steady.length / 2)] : -1;

  const firstAfter = seekedEv ? A.find((f) => f[0] >= seekedEv[0]) : null;
  console.log(`     frames presented ${F.length}, of which ADVANCED ${A.length}   median advance gap ${median}ms`);
  console.log(`     seeking -> seeked: ${seekMs}ms`);
  console.log(`     >>> PICTURE FREEZE (no advance): ${freeze}ms ${freeze > 400 ? '  <== VISIBLE STALL' : ''}`);
  if (firstAfter) console.log(`     first ADVANCING frame after seeked: mediaTime ${firstAfter[1]}s (target ${target}s) at ${rel(firstAfter[0])}`);
  if (seekEv && F.length) {
    const before = F.filter((f) => f[0] <= seekEv[0]).pop();
    if (before) console.log(`     last frame before click: mediaTime ${before[1]}s at ${rel(before[0])}`);
  }
  console.log('     media events:');
  for (const e of E) console.log(`       ${rel(e[0])}  ${e[1].padEnd(15)} ct=${String(e[2]).padStart(9)} rs=${e[3]} paused=${e[4]} ahead=${e[5]}s seeking=${e[6]}`);
  if (d.calls.length) { console.log('     script pause()/play()/load():'); for (const c of d.calls) console.log(`       ${rel(c[0])}  ${c[1]}()  ${c[2]}`); }
  else console.log('     script pause()/play()/load(): NONE');
  if (freeze > 300) {
    console.log('     100ms sampler across the freeze:');
    for (const s of d.samples) {
      if (s[0] >= at - 150 && s[0] <= at + freeze + 150) {
        console.log(`       ${rel(s[0])}  ct=${String(s[1]).padStart(9)} rs=${s[2]} paused=${s[3]} ahead=${s[4]}s seeking=${s[5]}`);
      }
    }
  }

  return { freeze, seekMs, median, target, label };
}

async function runOne(file, label) {
  console.log(`\n================================================================`);
  console.log(`${label}  (${(fs.statSync(file).size / 1073741824).toFixed(2)} GB)`);
  console.log(`================================================================`);
  const child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT, env: { ...process.env, MOVIRA_USER_DATA_DIR: profileDir() },
    stdio: 'ignore', windowsHide: true,
  });
  const out = [];
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
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await cdp.send('Page.bringToFront', {}).catch(() => {});

    await ev(cdp, `(() => { window.__moviraTestPlay([{ id: 't', type: 'video', title: ${JSON.stringify(label)}, path: ${JSON.stringify(file)} }], 0); return 1; })()`);
    let open = false;
    for (let i = 0; i < 400 && !open; i++) {
      await sleep(250);
      open = await ev(cdp, `(() => { const v=document.querySelector('video'); return !!(v && v.readyState >= 3 && !v.paused); })()`).catch(() => false);
    }
    if (!open) throw new Error('media never reached playback');
    await sleep(3000);
    await ev(cdp, HOOK);
    const box = await trackBox(cdp);
    const st = await evJson(cdp, `JSON.stringify((() => { const v = document.querySelector('video');
      return { rs: v.readyState, ns: v.networkState, paused: v.paused, preload: v.preload,
               src: v.currentSrc.slice(0, 42), blob: v.currentSrc.startsWith('blob:') }; })())`);
    console.log(`  duration ${hhmmss(box.dur)}  preload=${st.preload} rs=${st.rs} ns=${st.ns} src=${st.src}${st.blob ? ' (ffmpeg->MSE tier)' : ''}`);
    const live = await liveness(cdp);
    console.log(`  window liveness: ${live.fps} rAF fps, visibility=${live.vis}${live.fps < 30 ? '   *** THROTTLED — measurements below are NOT trustworthy ***' : ''}`);
    if (live.fps < 30) { console.log('  skipping measurement for this file'); return []; }

    out.push(await trial(cdp, box, 0.08, 0.45, 'forward single click'));
    out.push(await trial(cdp, box, 0.45, 0.12, 'backward single click'));
    out.push(await trial(cdp, box, 0.20, 0.78, 'far forward single click'));

    // WARM PLAYER. Every measurement above happens seconds after the file
    // opens, which is NOT what the user does: they watch for a while, then
    // click. Chromium's media cache grows with every second of playback, and a
    // seek has to discard all of it — so the stall can be a function of how
    // long the file has been playing rather than of the seek itself.
    const warm = Number(process.env.MOVIRA_WARM_MS || 45000);
    if (warm > 0) {
      console.log(`\n  --- warm player: ${warm / 1000}s of continuous playback first ---`);
      await ev(cdp, `window.__moviraServices.engine.seek(${Math.round(box.dur * 0.05)}).catch(()=>{})`);
      await sleep(warm);
      const wst = await evJson(cdp, `JSON.stringify((() => { const v = document.querySelector('video');
        let ahead = 0; for (let i = 0; i < v.buffered.length; i++) { if (v.buffered.start(i) <= v.currentTime + 0.25 && v.buffered.end(i) >= v.currentTime) { ahead = v.buffered.end(i) - v.currentTime; break; } }
        return { ct: +v.currentTime.toFixed(1), rs: v.readyState, paused: v.paused, ahead: +ahead.toFixed(1) }; })())`);
      console.log(`  after ${warm / 1000}s: position ${hhmmss(wst.ct)} rs=${wst.rs} paused=${wst.paused} bufferedAhead=${wst.ahead}s`);
      out.push(await trial(cdp, box, wst.ct / box.dur, 0.62, 'WARM forward single click'));
      out.push(await trial(cdp, box, 0.62, wst.ct / box.dur, 'WARM backward single click'));
    }
    if (cdp.errs.length) console.log('  renderer exceptions:', cdp.errs.slice(0, 4));
  } finally {
    try { child.kill(); } catch { /* ignore */ }
  }
  return out;
}

async function main() {
  console.log('Packaged exe:', EXE, fs.existsSync(EXE) ? '(found)' : '(MISSING)');
  const args = process.argv.slice(2).filter(Boolean);
  const files = args.length
    ? args.map((f) => ({ file: path.isAbsolute(f) ? f : path.resolve(process.cwd(), f), label: path.basename(f) }))
    : [{ file: path.join(MEDIA, 'movie-2.86gb.mkv'), label: 'movie-2.86gb.mkv' }];
  for (const f of files) if (!fs.existsSync(f.file)) throw new Error('not found: ' + f.file);

  const all = [];
  for (const f of files) all.push(...(await runOne(f.file, f.label)));

  console.log('\n================ SUMMARY ================');
  let worstAll = 0;
  for (const r of all) {
    if (r.freeze < 0) { console.log(`  ${r.label}: not measured`); continue; }
    worstAll = Math.max(worstAll, r.freeze);
    console.log(`  ${r.label.padEnd(26)} freeze ${String(r.freeze).padStart(5)}ms  seek->seeked ${String(r.seekMs).padStart(5)}ms  steady frame ${r.median}ms`);
  }
  console.log(`\nVERDICT: worst picture freeze = ${worstAll}ms ${worstAll > 400 ? ' -> VISIBLE 1-2s STALL' : ' -> no visible stall'}`);
  process.exit(0);
}

main().catch((e) => { console.error('DIAG FAILED:', e.stack); process.exit(2); });