/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * E2E: playback responsiveness + every transport interaction.
 *
 * This is the acceptance harness for "the movie lags when I seek / drag /
 * skip forward / skip back". It uses TRUSTED input events (CDP
 * Input.dispatchMouseEvent) rather than synthetic DOM events, so a click that a
 * real user could not land (off-screen, covered, blocked by an overlay) fails
 * here. It measures:
 *   - main-thread long tasks (>50ms) during steady playback and during seeks,
 *   - seek latency (input -> first frame at the new position),
 *   - how many bytes the MSE pipeline pulls while idle (the append pressure
 *     that starves the main thread when the whole file is buffered eagerly),
 *   - decoder restarts per seek.
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
function info(msg) { console.log(`  ....  ${msg}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-lag-'));
function gen(file, args) {
  const out = path.join(tmp, file);
  const argv = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const a of args) argv.push(a);
  execFileSync(ffmpeg, [...argv, out], { timeout: 300000 });
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
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message + ' [' + method + '] ' + JSON.stringify(msg.error.data ?? null))) : resolve(msg.result)));
      setTimeout(() => reject(new Error('CDP timeout: ' + method)), 180000);
    });
  }
}

async function evalJs(cdp, expression) {
  let r;
  try {
    r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  } catch (e) {
    console.error('evalJs failed for expression:', JSON.stringify(String(expression).slice(0, 400)));
    throw e;
  }
  if (r.exceptionDetails) throw new Error('Renderer exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

/* ---------------------------------------------------------------- input --- */

/** Centre of a selector in CSS pixels, or null when it is not reachable. */
async function centre(cdp, selector) {
  return evalJs(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height });
  })()`);
}

/** A REAL click: trusted pointer + mouse events through the browser input
 *  pipeline. Anything covering the element swallows it, exactly as for a user. */
async function realClick(cdp, selector) {
  const c = JSON.parse(await centre(cdp, selector));
  if (!c || c === 'null' || !c.w || !c.h) return { ok: false, why: 'missing' };
  const common = { x: c.x, y: c.y, button: 'left', clickCount: 1, buttons: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
  return { ok: true, ...c };
}

/** A REAL wheel gesture (trusted wheel event, not a synthetic one). */
async function realWheel(cdp, selector, deltaY) {
  const c = JSON.parse(await centre(cdp, selector));
  if (!c || c === 'null') return { ok: false, why: 'missing' };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY, pointerType: 'mouse' });
  return { ok: true, ...c };
}

/** A REAL press-move-release drag across the timeline. */
async function realDrag(cdp, fromFrac, toFrac, steps = 14) {
  const box = JSON.parse(await evalJs(cdp, `(() => {
    const r = document.querySelector('.timeline').getBoundingClientRect();
    return JSON.stringify({ left: r.left, top: r.top, w: r.width, h: r.height });
  })()`));
  const y = Math.round(box.top + box.h / 2);
  const x0 = Math.round(box.left + box.w * fromFrac);
  const x1 = Math.round(box.left + box.w * toFrac);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(x0 + (x1 - x0) * (i / steps));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await sleep(25);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y, button: 'left', clickCount: 1, buttons: 1 });
  return { x1, y, total: box.w, wantFrac: toFrac };
}

/* ------------------------------------------------------------ measuring --- */

/** Install a long-task observer + MSE byte counter in the page. */
const INSTRUMENT = `(() => {
  if (window.__lag) return 'already';
  window.__lag = { longTasks: [], total: 0, max: 0, marks: [] };
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__lag.longTasks.push(Math.round(e.duration));
        window.__lag.total += Math.round(e.duration);
        window.__lag.max = Math.max(window.__lag.max, Math.round(e.duration));
      }
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch (e) { window.__lag.err = String(e); }
  return 'ok';
})()`;

async function resetLag(cdp) {
  await evalJs(cdp, `(() => { window.__lag.longTasks.length = 0; window.__lag.total = 0; window.__lag.max = 0; return 1; })()`);
}
async function readLag(cdp) {
  return JSON.parse(await evalJs(cdp, `JSON.stringify({ n: window.__lag.longTasks.length, total: window.__lag.total, max: window.__lag.max })`));
}

const snap = () => `(() => {
  const v = document.querySelector('video');
  const s = window.__moviraServices;
  if (!v || !s) return JSON.stringify({ none: true });
  const d = window.__moviraMseDebug;
  const b = v.buffered;
  return JSON.stringify({
    paused: v.paused, rs: v.readyState, err: v.error ? v.error.code : null,
    ft: +s.engine.currentFileTime().toFixed(2),
    dur: isFinite(v.duration) ? +v.duration.toFixed(1) : null,
    durHint: s.engine.knownDuration(),
    bytes: d ? d.byteCount : -1,
    mse: d ? (d.__tag || (d.__tag = Math.floor(performance.now()))) : 0,
    bufEnd: b.length ? +b.end(b.length - 1).toFixed(1) : 0,
    bufStart: b.length ? +b.start(0).toFixed(1) : 0,
    intent: s.engine.isPlayingIntent() ? 1 : 0,
    tier2: s.engine.isFallbackBusy() ? 1 : 0,
    ahead: d ? d.bufferedAheadSec() : -1,
    trimmed: d ? d.trimmedCount : -1,
    audioIdx: s.engine.audioTrackIndex(),
    covers: (window.__coversAt === undefined || window.__coversAt === null) ? -1 : (s.engine.isBufferedAt(window.__coversAt) ? 1 : 0),
  });
})()`;

async function state(cdp) { return JSON.parse(await evalJs(cdp, snap())); }

async function waitPlaying(cdp, timeoutMs = 40000) {
  for (let i = 0; i * 250 < timeoutMs; i++) {
    await sleep(250);
    const s = await state(cdp);
    if (!s.none && !s.paused && s.rs >= 3 && s.err === null) return s;
  }
  return null;
}

/** Wait until the playhead is within `tol` of `want` (file time). */
/** Install (once) an instrumented media element: counts load(), src
 *  assignments and listener registrations/removals, and tags the element so a
 *  recreation is detectable. */
const MEDIA_SPY = `(() => {
  const w = window;
  if (!w.__mediaspy) {
    w.__mediaspy = { load: 0, srcSets: [], added: 0, removed: 0, token: null };
    const L = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = function () { w.__mediaspy.load++; return L.call(this); };
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      get() { return d.get.call(this); },
      set(v) { w.__mediaspy.srcSets.push(String(v).slice(0, 48)); return d.set.call(this, v); },
      configurable: true,
    });
    const A = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (t, f, o) {
      if (this instanceof HTMLMediaElement) w.__mediaspy.added++;
      return A.call(this, t, f, o);
    };
    const Rm = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.removeEventListener = function (t, f, o) {
      if (this instanceof HTMLMediaElement) w.__mediaspy.removed++;
      return Rm.call(this, t, f, o);
    };
  }
  return 1;
})()`;

/** Zero the counters and tag the CURRENT element as the one that must survive. */
async function armSpy(cdp) {
  await evalJs(cdp, MEDIA_SPY);
  await evalJs(cdp, `(() => { const s = window.__mediaspy; const v = document.querySelector('video');
    s.token = 'tok-' + Math.floor(performance.now() * 1000);
    v.__moviraToken = s.token; s.load = 0; s.srcSets = []; s.added = 0; s.removed = 0; return 1; })()`);
}
async function readSpy(cdp) {
  return JSON.parse(await evalJs(cdp, `(() => { const s = window.__mediaspy; const v = document.querySelector('video');
    return JSON.stringify({ load: s.load, srcSets: s.srcSets.length, firstSrc: s.srcSets[0] || null,
      live: s.added - s.removed, sameElement: !!v && v.__moviraToken === s.token }); })()`));
}

async function waitAt(cdp, want, tol = 1.5, timeoutMs = 20000) {
  const t0 = Date.now();
  for (let i = 0; i * 100 < timeoutMs; i++) {
    await sleep(100);
    const s = await state(cdp);
    if (!s.none && Math.abs(s.ft - want) < tol) return { ms: Date.now() - t0, s };
  }
  return { ms: Date.now() - t0, s: await state(cdp), missed: true };
}

async function playPath(cdp, p, label, type = 'video') {
  await evalJs(cdp, `(async () => {
    window.__moviraTestPlay([{ id: 'lag-${label}', type: ${JSON.stringify(type)}, title: ${JSON.stringify(label)}, path: ${JSON.stringify(p)} }], 0);
    return 'ok';
  })()`);
  return !!(await waitPlaying(cdp));
}

async function main() {
  console.log('Generating media (720p 240s mkv + mp4, muted)...');
  const V = ['testsrc=size=1280x720:rate=25:duration=240', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-b:v', '1500k'];
  const A = ['-c:a', 'aac', '-b:a', '128k'];
  // MKV with TWO audio tracks and TWO subtitle streams: Chromium cannot demux
  // matroska at all, so this is the tier-2 path a real movie takes, and it
  // exercises the B / V track switching requirement.
  const subEn = path.join(tmp, 'stream-en.srt');
  const subHi = path.join(tmp, 'stream-hi.srt');
  fs.writeFileSync(subEn, '1\n00:00:02,000 --> 00:01:00,000\nEnglish embedded subtitle\n');
  fs.writeFileSync(subHi, '1\n00:00:04,000 --> 00:01:00,000\nHindi embedded subtitle\n');
  const mkv = gen('movie.mkv', [
    '-f', 'lavfi', '-i', V[0],
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=240,volume=0',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=240,volume=0',
    '-i', subEn, '-i', subHi,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map', '4:s',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-b:v', '1500k',
    '-c:a', 'aac', '-b:a', '128k', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=hin',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=hin',
    '-f', 'matroska',
  ]);
  const mp4 = gen('movie.mp4', ['-f', 'lavfi', '-i', V[0], '-f', 'lavfi', '-i', 'sine=frequency=440:duration=240,volume=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-b:v', '1500k', '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4']);
  // MPEG-TS with MPEG-2 video and TWO audio tracks. Chromium cannot demux TS
  // or decode mpeg2video at all, so this file ALWAYS takes the tier-2 path
  // (ffmpeg -> fragmented MP4 -> MSE) — which is the pipeline that actually
  // lagged. An h264 mkv would be played natively by Chromium and the whole
  // buffering/seek story would go untested.
  const ts = gen('movie.ts', [
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=240',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=240,volume=0',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=240,volume=0',
    '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'mpeg2video', '-b:v', '2000k',
    '-c:a', 'aac', '-b:a', '128k',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=hin',
    '-f', 'mpegts',
  ]);
  // Sidecar subtitles for the V key on the native file.
  fs.writeFileSync(path.join(tmp, 'movie.srt'), '1\n00:00:02,000 --> 00:00:08,000\nMovira sidecar subtitle\n');
  fs.writeFileSync(path.join(tmp, 'movie.ass'), '[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,36\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:03.00,0:00:09.00,Default,,0,0,0,,Movira ASS subtitle\n');

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
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await sleep(500);
      ready = await evalJs(cdp, `!!(window.__moviraTestPlay && window.__moviraServices)`).catch(() => false);
    }
    if (!ready) throw new Error('renderer never became ready');
    await evalJs(cdp, INSTRUMENT);

    // ------------------------------------------------------------------
    console.log('\n== Tier 2 (mpeg-ts): steady playback must not starve the main thread ==');
    ok('ts opens and plays (tier 2)', await playPath(cdp, ts, 'ts'));
    ok('the ffmpeg/MSE pipeline really is in use', (await state(cdp)).tier2 === 1, 'a natively-decodable file here would skip the whole tier-2 path');
    await sleep(3000);
    {
      await resetLag(cdp);
      const before = await state(cdp);
      await sleep(6000);
      const after = await state(cdp);
      const lag = await readLag(cdp);
      const pulled = after.bytes - before.bytes;
      const mb = (pulled / 1048576).toFixed(1);
      info(`steady 6s: longTasks=${lag.n} (total ${lag.total}ms, max ${lag.max}ms), pulled ${mb}MB, buffered ${before.bufStart}-${after.bufEnd}s of ${after.durHint}s, ${after.ahead}s ahead`);
      ok('playback advances', after.ft > before.ft + 4, `${before.ft} -> ${after.ft}`);
      ok('no long task longer than 250ms while playing', lag.max < 250, `max=${lag.max}ms over ${lag.n} tasks`);
      // Buffering AHEAD is what makes a seek a one-line currentTime write, so
      // it must stay generous. Memory is bounded from BEHIND instead, which is
      // what trimmedCount reports.
      ok('a wide forward window is buffered (seeks stay in-buffer)', after.ahead > 20, `${after.ahead}s ahead of the playhead`);
      // ...but it must be a WINDOW, not unbounded. Draining the whole source as
      // fast as it arrives is invisible on a 240s clip and catastrophic on a
      // 2-hour movie: a continuous flood of synchronous appendBuffer() starves
      // the main thread, and the wheel / seek clicks / skip buttons stop
      // responding. This assertion is the guard for that regression.
      ok('the forward window stays bounded (the UI is never starved)', after.ahead < 400, `${after.ahead}s ahead — a 240s clip fully buffered means the window is unbounded`);
    }

    // ------------------------------------------------------------------
    console.log('\n== Seek latency (trusted clicks on the timeline) ==');
    const dur = (await state(cdp)).durHint || 240;
    for (const frac of [0.75, 0.2, 0.6, 0.35]) {
      const want = frac * dur;
      // Ask the ENGINE whether this target is already decoded. Only then is
      // "no pipeline restart" the correct expectation — a target beyond the
      // buffer genuinely needs a new ffmpeg.
      await evalJs(cdp, `(() => { window.__coversAt = ${want}; return 1; })()`);
      const pre = await state(cdp);
      const covered = pre.covers === 1;
      const mseBefore = pre.mse;
      const box = JSON.parse(await evalJs(cdp, `(() => { const r = document.querySelector('.timeline').getBoundingClientRect(); return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height }); })()`));
      const x = Math.round(box.l + box.w * frac);
      const y = Math.round(box.t + box.h / 2);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 1 });
      await resetLag(cdp);
      const t0 = Date.now();
      const hit = await waitAt(cdp, want, 2.0, 25000);
      const lag = await readLag(cdp);
      const st = hit.s;
      const restarts = st && st.mse !== mseBefore ? 'RESTARTED' : 'in-buffer';
      info(`click ${(frac * 100) | 0}%: ${hit.missed ? 'MISSED' : hit.ms + 'ms'} (${covered ? 'target already buffered' : 'target beyond buffer'}, ${restarts}), longTasks=${lag.n} max=${lag.max}ms`);
      ok(`seek to ${(frac * 100) | 0}% lands and stays responsive`, !hit.missed && lag.max < 700, `${hit.ms}ms, max long task ${lag.max}ms`);
      ok(`seek to ${(frac * 100) | 0}% inside the buffered window needs NO restart`, !covered || restarts === 'in-buffer', restarts);
    }

    // ------------------------------------------------------------------
    console.log('\n== Timeline drag ==');
    {
      // Start from a genuinely playing element, otherwise the before/after
      // comparison below is meaningless.
      if (!(await waitPlaying(cdp, 15000))) await evalJs(cdp, `(async () => { await document.querySelector('video').play(); return 1; })()`);
      const before = await state(cdp);
      await resetLag(cdp);
      const want = 0.85 * dur;
      await realDrag(cdp, 0.85, 0.85);
      const hit = await waitAt(cdp, want, 2.5, 25000);
      const lag = await readLag(cdp);
      const after = hit.s;
      info(`drag: ${hit.missed ? 'MISSED' : hit.ms + 'ms'}, longTasks=${lag.n} max=${lag.max}ms`);
      ok('drag release lands at the released position', !hit.missed, `${hit.ms}ms ft=${after && after.ft}`);
      ok('drag stays responsive (no long task > 500ms)', lag.max < 500, `max=${lag.max}ms over ${lag.n}`);
      // The playhead keeps running after the drag, so it is legitimately a
      // little PAST the release point — only a wild jump would be a failure.
      ok('playback still advancing after the drag', after && after.ft > want - 1.5, `${after && after.ft} vs ${want}`);
      ok('drag did not lose playback', before.paused === false && after && after.paused === false, `before.paused=${before.paused} after.paused=${after && after.paused}`);
    }

    // ------------------------------------------------------------------
    // The skip buttons are 10 s in-time skips (playlist navigation lives on
    // Ctrl+left/right). This block used to assert playlist semantics under the
    // old titles, so it passed without testing anything: with a single-item
    // queue `next` returned early and the button was literally dead.
    console.log('\n== Skip buttons are 10s in-time skips ==');
    {
      await evalJs(cdp, `(async () => { await window.__moviraServices.engine.pause(); return 1; })()`);
      await sleep(400);
      // Park far enough from both ends that a 10 s skip is never a clamp.
      await evalJs(cdp, `(async () => { await window.__moviraServices.engine.seek(${Math.round(dur * 0.5)}); return 1; })()`);
      await sleep(2500);

      // Forward: four clicks must land 4 x 10 s ahead, and only the final
      // position matters since playback is paused (nothing drifts).
      await armSpy(cdp);
      const b4 = await state(cdp);
      for (let i = 0; i < 4; i++) {
        await realClick(cdp, '.left button[title^="Next"]');
        await sleep(700);
      }
      const a4 = await state(cdp);
      const spy4 = await readSpy(cdp);
      const fwdWant = b4.ft + 40;
      info(`4x skip forward: ft ${b4.ft} -> ${a4.ft} (want ~${fwdWant})`);
      ok('four forward skips land 40s ahead', Math.abs(a4.ft - fwdWant) < 3, `got ${a4.ft}, want ${fwdWant.toFixed(1)}`);
      ok('forward skips never reload the media', spy4.load === 0 && spy4.srcSets === 0, `load()=${spy4.load} srcSets=${spy4.srcSets}`);

      const b1 = await state(cdp);
      await realClick(cdp, '.left button[title^="Previous"]');
      await sleep(900);
      const a1 = await state(cdp);
      const backWant = b1.ft - 10;
      info(`1x skip back: ft ${b1.ft} -> ${a1.ft} (want ~${backWant})`);
      ok('a back skip lands 10s behind', Math.abs(a1.ft - backWant) < 3, `got ${a1.ft}, want ${backWant.toFixed(1)}`);
      ok('the player is still healthy after skipping', !a1.err && a1.rs >= 2, JSON.stringify(a1));

      // This block pauses via the ENGINE (not by poking the element) so the
      // measured positions do not drift between clicks AND the engine's
      // user-paused intent stays consistent. Pausing the element directly left
      // that intent describing something the engine never did, and the NEXT
      // block then failed intermittently for reasons unrelated to seeking.
      await evalJs(cdp, `(async () => { await window.__moviraServices.engine.play(); return 1; })()`);
      await sleep(1000);
      ok('playback resumed for the next section', !(await state(cdp)).paused);
    }

    // ------------------------------------------------------------------
    console.log('\n== Stress: fwd/back/fwd/back + click + drag ==');
    {
      await resetLag(cdp);
      const seq = ['ArrowRight', 'ArrowLeft', 'ArrowRight', 'ArrowLeft'];
      for (const k of seq) {
        await evalJs(cdp, `(() => { const e = new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return 1; })()`);
        await sleep(900);
      }
      const box = JSON.parse(await evalJs(cdp, `(() => { const r = document.querySelector('.timeline').getBoundingClientRect(); return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height }); })()`));
      const y = Math.round(box.t + box.h / 2);
      const x = Math.round(box.l + box.w * 0.45);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(1500);
      await realDrag(cdp, 0.5, 0.7);
      // A seek that lands outside the buffer rebuilds the ffmpeg pipeline, so
      // wait for playback to come back rather than guessing a sleep.
      const back = await waitPlaying(cdp, 20000);
      ok('playback comes back after the stress sequence', !!back, back ? '' : 'still not playing 20s after the last drag');
      const st = await state(cdp);
      const lag = await readLag(cdp);
      info(`after stress: ft=${st.ft} rs=${st.rs} paused=${st.paused} longTasks=${lag.n} max=${lag.max}ms total=${lag.total}ms`);
      ok('player survives the stress sequence', !st.err && st.rs >= 3 && !st.paused, JSON.stringify(st));
      ok('the timeline keeps the real duration after all that seeking', Math.abs((st.durHint || 0) - dur) < 3, `durHint=${st.durHint} expected ~${dur}`);
      ok('stress produced no pathological long task', lag.max < 900, `max=${lag.max}ms`);
      const adv = await waitAt(cdp, st.ft + 1.2, 1.0, 6000);
      ok('playback still advancing after the stress sequence', !adv.missed, `ft=${adv.s && adv.s.ft}`);
    }

    // ------------------------------------------------------------------
    console.log('\n== Mouse wheel volume (trusted wheel events) ==');
    {
      const v0 = (await state(cdp)).ft;
      const readVol = async () => JSON.parse(await evalJs(cdp, `(() => { const v = document.querySelector('video'); const el = document.querySelector('.volume-zone button'); const s = document.querySelector('.volume-slider'); return JSON.stringify({ vol: v.volume, muted: v.muted, glyph: el ? el.textContent : '', pct: el ? el.getAttribute('data-volume') : null, aria: s ? s.getAttribute('aria-valuenow') : null }); })()`));
      // Start from a known mid level so "wheel up" has somewhere to go (the
      // default is already 100%, where an upward step is correctly a no-op).
      await evalJs(cdp, `(() => { const v = document.querySelector('video'); v.muted = false; v.volume = 0.5; return 1; })()`);
      await sleep(300);
      const before = await readVol();
      const up = await realWheel(cdp, '.volume-slider', -120);
      await sleep(400);
      const afterUp = await readVol();
      info(`wheel up over slider: ${before.vol.toFixed(2)} -> ${afterUp.vol.toFixed(2)} (glyph ${before.glyph}->${afterUp.glyph}, aria ${afterUp.aria})`);
      ok('wheel up over the volume control raises the volume', up.ok && afterUp.vol > before.vol + 0.01, `${before.vol} -> ${afterUp.vol}`);
      ok('the volume button shows the new level immediately', Number(afterUp.pct) === Math.round(afterUp.vol * 100) && afterUp.pct !== before.pct, `pct ${before.pct}->${afterUp.pct} vol=${afterUp.vol}`);
      ok('the slider knob follows the wheel', Number(afterUp.aria) === Math.round(afterUp.vol * 100), `aria=${afterUp.aria} vol=${afterUp.vol}`);
      const down = await realWheel(cdp, '.volume-slider', 120);
      await sleep(400);
      const afterDown = await readVol();
      ok('wheel down lowers the volume', down.ok && afterDown.vol < afterUp.vol - 0.01, `${afterUp.vol} -> ${afterDown.vol}`);
      // Clamp at 0 then back up.
      const vCentre = JSON.parse(await centre(cdp, '.volume-slider'));
      for (let i = 0; i < 40; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vCentre.x, y: vCentre.y, deltaX: 0, deltaY: 120, pointerType: 'mouse' });
      await sleep(500);
      const atZero = await readVol();
      ok('volume clamps at 0% and mutes', atZero.vol === 0 && atZero.muted === true, JSON.stringify(atZero));
      ok('mute glyph reflects zero volume', atZero.glyph.includes('🔇'), atZero.glyph);
      const c = JSON.parse(await centre(cdp, '.volume-slider'));
      for (let i = 0; i < 8; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: -120, pointerType: 'mouse' });
      await sleep(500);
      const back = await readVol();
      ok('volume comes back from mute and unmutes', back.vol > 0.05 && back.muted === false, JSON.stringify(back));
      ok('volume indicator follows the volume', Number(back.aria) === Math.round(back.vol * 100), `aria=${back.aria} vol=${back.vol}`);
      // Wheel over the volume must NOT seek.
      const beforeWheel = await state(cdp);
      await realWheel(cdp, '.volume-slider', -120);
      await sleep(500);
      const afterWheel = await state(cdp);
      ok('wheel over the volume control does not seek', Math.abs(afterWheel.ft - beforeWheel.ft) < 3, `${beforeWheel.ft} -> ${afterWheel.ft}`);
      // Wheel over the mute button (inside the same zone).
      const muteBefore = await readVol();
      await realWheel(cdp, '.volume-zone button', -120);
      await sleep(400);
      const muteAfter = await readVol();
      ok('wheel over the mute button also steps the volume', muteAfter.vol > muteBefore.vol - 0.01, `${muteBefore.vol} -> ${muteAfter.vol}`);
      // Real drag of the slider.
      const vb = JSON.parse(await evalJs(cdp, `(() => { const r = document.querySelector('.volume-slider').getBoundingClientRect(); return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height }); })()`));
      const vy = Math.round(vb.t + vb.h / 2);
      const vx = Math.round(vb.l + vb.w * 0.3);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vx, y: vy });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vx, y: vy, button: 'left', clickCount: 1, buttons: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vx, y: vy, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(400);
      const afterDrag = await readVol();
      ok('dragging the volume slider sets the volume', Math.abs(afterDrag.vol - 0.3) < 0.08, JSON.stringify(afterDrag));
      await evalJs(cdp, `(async () => { const e = document.querySelector('.volume-slider'); const k = { key: 'Home', bubbles: true, cancelable: true }; e.dispatchEvent(new KeyboardEvent('keydown', k)); return 1; })()`);
      await sleep(300);
    }

    // ------------------------------------------------------------------
    console.log('\n== Mouse wheel over the VIDEO area (VLC: whole player controls volume) ==');
    {
      await evalJs(cdp, `(() => { const v = document.querySelector('video'); v.muted = false; v.volume = 0.5; return 1; })()`);
      await sleep(300);
      const readVol = async () => JSON.parse(await evalJs(cdp, `JSON.stringify({ vol: document.querySelector('video').volume, muted: document.querySelector('video').muted, pct: document.querySelector('.volume-btn') ? document.querySelector('.volume-btn').getAttribute('data-volume') : null })`));
      // The pointer is over the VIDEO, not over any volume control.
      const posBefore = (await state(cdp)).ft;
      const up = await realWheel(cdp, '.player-stage', -120);
      await sleep(350);
      const afterUp = await readVol();
      ok('wheel over the video raises the volume', up.ok && afterUp.vol > 0.5, `${up.ok} 0.5 -> ${afterUp.vol}`);
      ok('the volume readout follows the wheel over the video', Number(afterUp.pct) === Math.round(afterUp.vol * 100), `pct=${afterUp.pct} vol=${afterUp.vol}`);
      const down = await realWheel(cdp, '.player-stage', 120);
      await sleep(350);
      const afterDown = await readVol();
      ok('wheel down over the video lowers the volume', down.ok && afterDown.vol < afterUp.vol - 0.01, `${afterUp.vol} -> ${afterDown.vol}`);
      const posAfter = (await state(cdp)).ft;
      ok('wheel over the video does NOT seek', Math.abs(posAfter - posBefore) < 3, `${posBefore} -> ${posAfter}`);
      // Outside the player the wheel is left completely alone.
      const outside = await realWheel(cdp, '.topbar', -120);
      await sleep(350);
      const afterOutside = await readVol();
      ok('wheel outside the player does NOT change the volume', !outside.ok || Math.abs(afterOutside.vol - afterDown.vol) < 0.001, `${afterDown.vol} -> ${afterOutside.vol}`);
      // Clamping still holds when driven from the video area.
      const vc = JSON.parse(await centre(cdp, '.player-stage'));
      for (let i = 0; i < 40; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vc.x, y: vc.y, deltaX: 0, deltaY: 120, pointerType: 'mouse' });
      await sleep(400);
      const zero = await readVol();
      ok('wheel over the video clamps at 0% and mutes', zero.vol === 0 && zero.muted === true, JSON.stringify(zero));
      for (let i = 0; i < 8; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vc.x, y: vc.y, deltaX: 0, deltaY: -120, pointerType: 'mouse' });
      await sleep(350);
      const backUp = await readVol();
      ok('wheel over the video comes back from mute', backUp.vol > 0.05 && backUp.muted === false, JSON.stringify(backUp));
    }

    // ------------------------------------------------------------------
    console.log('\n== Seeking must never reload, reassign src or recreate the element ==');
    {
      await armSpy(cdp);
      const s0 = await readSpy(cdp);
      // The "seek -> click -> seek -> click" pattern from the bug report. Each
      // target is checked against the engine's own buffer coverage: a target
      // already decoded MUST NOT rebuild the pipeline, and any target that
      // genuinely needs a new decoder must land fast without STACKING.
      let inBufferSeeks = 0, reloadsWhenInBuffer = 0, worstMs = 0;
      for (const frac of [0.7, 0.2, 0.85, 0.3, 0.6, 0.1]) {
        const dur = (await state(cdp)).durHint || 240;
        const want = frac * dur;
        await evalJs(cdp, `(() => { window.__coversAt = ${want}; return 1; })()`);
        const pre = await state(cdp);
        const covered = pre.covers === 1;
        const loadBefore = (await readSpy(cdp)).load;
        const box = JSON.parse(await evalJs(cdp, `(() => { const r = document.querySelector('.timeline').getBoundingClientRect(); return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height }); })()`));
        const x = Math.round(box.l + box.w * frac), y = Math.round(box.t + box.h / 2);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 1 });
        const hit = await waitAt(cdp, want, 3.0, 25000);
        worstMs = Math.max(worstMs, hit.missed ? 99999 : hit.ms);
        const post = await readSpy(cdp);
        if (covered) {
          inBufferSeeks++;
          if (post.load > loadBefore) reloadsWhenInBuffer++;
        }
        await sleep(200);
      }
      const s1 = await readSpy(cdp);
      info(`6 seeks: ${inBufferSeeks} inside the buffered window, ${reloadsWhenInBuffer} of them reloaded, worst landing ${worstMs}ms, net media listeners ${s1.live - s0.live}`);
      ok('every seek to an already-buffered position is a pure currentTime write', reloadsWhenInBuffer === 0, `${reloadsWhenInBuffer}/${inBufferSeeks} reloaded`);
      ok('6 repeated seeks never recreate the media element', s1.sameElement === true);
      ok('seeking leaks no media listeners', s1.live - s0.live === 0, `net +${s1.live - s0.live}`);
      ok('every repeated seek lands quickly', worstMs < 2500, `worst ${worstMs}ms`);

      await realDrag(cdp, 0.5, 0.25);
      await sleep(900);
      ok('dragging keeps the same media element', (await readSpy(cdp)).sameElement === true);

      // Forward / backward buttons.
      await armSpy(cdp);
      await realClick(cdp, '.left button[title^="Next"]');
      await sleep(600);
      await realClick(cdp, '.left button[title^="Previous"]');
      await sleep(900);
      const s3 = await readSpy(cdp);
      info(`Next+Previous: load()=${s3.load} src=${s3.srcSets} sameElement=${s3.sameElement}`);
      ok('forward/backward keep the same media element', s3.sameElement === true);

      // Stop -> Play must be clean, and seeking must still work afterwards.
      // Three full cycles: a reload legitimately leaves the NEW pipeline's
      // listeners attached, so the real leak test is whether that count GROWS
      // from one cycle to the next.
      const livePerCycle = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        await realClick(cdp, '.left button[title="Stop"]');
        await sleep(800);
        const stopped = await state(cdp);
        if (cycle === 0) ok('Stop detaches cleanly', stopped.paused === true && stopped.rs === 0, JSON.stringify(stopped));
        await armSpy(cdp);
        // Through the real transport button — the engine, not the raw element.
        await realClick(cdp, '.play-btn');
        const back = await waitPlaying(cdp, 25000);
        if (cycle === 0) ok('Play after Stop restarts playback', !!back, back ? '' : 'never resumed');
        if (!back) break;
        livePerCycle.push((await readSpy(cdp)).live);
      }
      info(`Stop->Play x3, live media listeners per cycle: ${JSON.stringify(livePerCycle)}`);
      ok('repeated Stop -> Play does not accumulate media listeners',
        livePerCycle.length === 3 && livePerCycle[2] <= livePerCycle[0],
        `${JSON.stringify(livePerCycle)}`);
      const s4 = await readSpy(cdp);
      ok('Stop -> Play keeps the same media element', s4.sameElement === true);
      const box = JSON.parse(await evalJs(cdp, `(() => { const r = document.querySelector('.timeline').getBoundingClientRect(); return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height }); })()`));
      const x = Math.round(box.l + box.w * 0.4), y = Math.round(box.t + box.h / 2);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 1 });
      const hit = await waitAt(cdp, 0.4 * ((await state(cdp)).durHint || 240), 3.0, 20000);
      ok('seeking still works after Stop -> Play', !hit.missed, `${hit.missed ? 'MISSED' : hit.ms + 'ms'} ft=${hit.s && hit.s.ft}`);
    }

    // ------------------------------------------------------------------
    console.log('\n== Native tier: seeking is a pure currentTime write, full stop ==');
    {
      // On a natively-decodable file (an ordinary mp4/mkv movie) there is NO
      // fallback pipeline, so this is where the "never reload" rule can be
      // asserted without exceptions.
      ok('mp4 opens and plays', await playPath(cdp, mp4, 'mp4-spy'));
      await waitPlaying(cdp, 20000);
      await armSpy(cdp);
      const n0 = await readSpy(cdp);
      const d = (await state(cdp)).durHint || 240;
      for (const frac of [0.7, 0.2, 0.85, 0.3, 0.6, 0.1, 0.45, 0.95]) {
        const box = JSON.parse(await evalJs(cdp, `(() => { const r = document.querySelector('.timeline').getBoundingClientRect(); return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height }); })()`));
        const x = Math.round(box.l + box.w * frac), y = Math.round(box.t + box.h / 2);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 1 });
        const h = await waitAt(cdp, frac * d, 2.5, 15000);
        if (h.missed) { info(`  native seek ${(frac * 100) | 0}% MISSED`); }
        await sleep(200);
      }
      await realDrag(cdp, 0.8, 0.15);
      await sleep(700);
      for (let i = 0; i < 4; i++) { await evalJs(cdp, `(() => { const e = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return 1; })()`); await sleep(250); }
      for (let i = 0; i < 4; i++) { await evalJs(cdp, `(() => { const e = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return 1; })()`); await sleep(250); }
      const n1 = await readSpy(cdp);
      // The native tier now binds ONE permanent 'seeked' listener so a storm of
      // currentTime writes can be coalesced onto the element's own seek state
      // machine. A single constant listener is not a leak; growth per seek is.
      // So the leak test is the DIFFERENCE between two equally long rounds.
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 4; i++) { await evalJs(cdp, `(() => { const e = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return 1; })()`); await sleep(150); }
        for (let i = 0; i < 4; i++) { await evalJs(cdp, `(() => { const e = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return 1; })()`); await sleep(150); }
      }
      const n2 = await readSpy(cdp);
      info(`native: 8 clicks + drag + 8 keyboard steps -> load()=${n1.load} src=${n1.srcSets} sameElement=${n1.sameElement} net listeners ${n1.live - n0.live}`);
      info(`native: 24 more keyboard steps -> net listeners ${n2.live - n1.live}, load()=${n2.load - n1.load}`);
      ok('native: repeated seeking never calls video.load()', n1.load === 0 && n2.load === n1.load, `load() x${n1.load}`);
      ok('native: repeated seeking never reassigns video.src', n1.srcSets === 0 && n2.srcSets === n1.srcSets, `${n1.srcSets} assignments`);
      ok('native: seeking never recreates the video element', n1.sameElement === true);
      ok('native: seeking does not add listeners per seek', n2.live - n1.live === 0, `+${n2.live - n1.live} over 24 more steps`);
      const nSt = await state(cdp);
      ok('native: still playing after the whole sequence', !nSt.err && !nSt.paused && nSt.rs >= 3, JSON.stringify(nSt));
    }

    // ------------------------------------------------------------------
    console.log('\n== Secondary panels never block each other (trusted clicks) ==');
    {
      const nav = (label) => `.topbar .btn.topbar-nav[title="${label}"]`;
      const navByText = async (text) => JSON.parse(await evalJs(cdp, `(() => {
        const b = Array.from(document.querySelectorAll('.topbar .btn.topbar-nav')).find((x) => x.textContent.trim() === ${JSON.stringify(text)});
        if (!b) return 'null';
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`));
      const clickNav = async (text) => {
        const c = await navByText(text);
        if (!c || c === 'null') return 'missing';
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1, buttons: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1, buttons: 1 });
        await sleep(500);
        return 'clicked';
      };
      const openPanels = async () => JSON.parse(await evalJs(cdp, `JSON.stringify(Array.from(document.querySelectorAll('.floating-panel')).map((p) => p.querySelector('.settings-view, .library-view, .playlists-view, .home-view') ? (p.querySelector('.settings-view') ? 'settings' : p.querySelector('.library-view') ? 'library' : p.querySelector('.playlists-view') ? 'playlists' : 'home') : '?'))`));
      await clickNav('Settings');
      ok('Settings opens with one click', (await openPanels()).includes('settings'), JSON.stringify(await openPanels()));
      await clickNav('Playlist');
      const afterSwitch = await openPanels();
      ok('Playlist takes over with ONE click while Settings is open', afterSwitch.includes('playlists') && !afterSwitch.includes('settings'), JSON.stringify(afterSwitch));
      await clickNav('Library');
      const afterLib = await openPanels();
      ok('Library takes over with one click', afterLib.includes('library') && !afterLib.includes('playlists'), JSON.stringify(afterLib));
      await clickNav('Home');
      const afterHome = await openPanels();
      ok('Home takes over with one click', afterHome.includes('home') && afterHome.length === 1, JSON.stringify(afterHome));
      // No overlay may remain over the main interface.
      const blockers = JSON.parse(await evalJs(cdp, `(() => {
        const bad = [];
        const vh = innerHeight, vw = innerWidth;
        document.querySelectorAll('.floating-backdrop, .floating-panel, [class*=backdrop], [class*=overlay], [class*=modal]').forEach((o) => {
          const r = o.getBoundingClientRect();
          if (r.width > vw * 0.95 && r.height > vh * 0.95 && getComputedStyle(o).pointerEvents !== 'none') bad.push(o.className);
        });
        // Anything covering the transport or top bar?
        const probe = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h ? h.tagName + '.' + String(h.className || '').slice(0, 26) : 'null'; };
        return JSON.stringify({ fullScreenOverlays: bad, transportHit: probe('.transport'), playBtnHit: probe('.play-btn'), topbarHit: probe('.topbar .btn.topbar-nav') });
      })()`));
      ok('no full-screen overlay / focus trap left over a panel', blockers.fullScreenOverlays.length === 0, JSON.stringify(blockers));
      ok('transport stays clickable with a panel open', !/floating/.test(String(blockers.transportHit)), String(blockers.transportHit));
      const hit = await realClick(cdp, '.play-btn');
      // Verify the click really landed on the button rather than on a panel
      // floating over it: realClick only proves the element exists. Report what
      // was on top, so a miss is diagnosable instead of looking like a dead
      // pause handler.
      const onTop = await evalJs(cdp, `(() => {
        const b = document.querySelector('.play-btn');
        if (!b) return 'null';
        const r = b.getBoundingClientRect();
        const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return h ? (h === b ? 'play-btn' : h.tagName + '.' + String(h.className || '').slice(0, 30)) : 'null';
      })()`);
      await sleep(900);
      let st = await state(cdp);
      if (!st.paused) {
        // One retry: distinguishes a click lost to a still-animating panel from
        // a pause handler that genuinely stopped responding.
        await realClick(cdp, '.play-btn');
        await sleep(900);
        st = await state(cdp);
      }
      ok('pause still works with a panel open', hit.ok && st.paused === true, JSON.stringify({ hit, onTop, st }));
      if (st.paused) { await realClick(cdp, '.play-btn'); await sleep(1200); }
      await evalJs(cdp, `(() => { const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return 1; })()`);
      await sleep(400);
      ok('Escape closes the panel', (await openPanels()).length === 0, JSON.stringify(await openPanels()));
    }

    // ------------------------------------------------------------------
    console.log('\n== B (audio) and V (subtitle) operate on real tracks ==');
    {
      const key = async (k) => { await evalJs(cdp, `(() => { const e = new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return 1; })()`); await sleep(1200); };
      const probe = async () => JSON.parse(await evalJs(cdp, `(() => {
        const v = document.querySelector('video');
        const at = v.audioTracks;
        const tt = v.textTracks;
        const labels = Array.from(v.querySelectorAll('track')).map((t) => t.label);
        return JSON.stringify({
          audioApi: !!at, audioCount: at ? at.length : 0, audioEnabled: at ? Array.from({ length: at.length }, (_, i) => at[i].enabled) : [],
          engineAudio: window.__moviraServices.engine.audioTrackIndex(),
          textCount: tt ? tt.length : 0, textModes: tt ? Array.from({ length: tt.length }, (_, i) => tt[i].mode) : [],
          labels,
        });
      })()`));

      // --- B on the tier-2 file: MSE carries ONE muxed audio stream, so the
      // switch has to re-mux. It must be the REAL track and must not stall.
      // Re-select it explicitly: earlier sections may have left another file
      // loaded, and a single-track file must be a graceful no-op, not a pass.
      ok('ts re-selected for the audio-track test', await playPath(cdp, ts, 'ts-audio'));
      await waitPlaying(cdp, 20000);
      const tracks = JSON.parse(await evalJs(cdp, `window.__moviraServices.engine.getTracks().then(t => JSON.stringify({ a: t.audio.map(x => x.language), s: t.subs.map(x => x.language) }))`));
      info(`probe found audio=${JSON.stringify(tracks.a)} subs=${JSON.stringify(tracks.s)}`);
      ok('the probe reports the file REAL audio tracks', tracks.a.length >= 2, JSON.stringify(tracks.a));
      const posBeforeB = (await state(cdp)).ft;
      await key('b');
      // MSE carries ONE muxed audio stream, so switching tracks is a full
      // decoder restart: ffmpeg is respawned at the current position. The
      // element is legitimately EMPTY for a few hundred ms, so the state has
      // to be read after the restart settles, not immediately.
      await waitPlaying(cdp, 20000);
      const afterB = await probe();
      const stB = await state(cdp);
      info(`after B: engineAudio=${afterB.engineAudio} ft=${posBeforeB}->${stB.ft} tier2=${stB.tier2}`);
      ok('B switches to the next real audio track', afterB.engineAudio === 1, `engineAudioIndex=${afterB.engineAudio}`);
      ok('B keeps the position and keeps playing', Math.abs(stB.ft - posBeforeB) < 8 && !stB.paused && stB.rs >= 2, JSON.stringify(stB));
      await key('b');
      const afterB2 = await probe();
      ok('B cycles back round to the first track', afterB2.engineAudio === 0, `engineAudioIndex=${afterB2.engineAudio}`);

      // --- V on the mkv, which carries embedded subtitle streams plus a
      // sidecar file: off -> sidecar -> embedded -> off.
      ok('mkv opens and plays', await playPath(cdp, mkv, 'mkv'));
      await sleep(1500);
      const subTracks = JSON.parse(await evalJs(cdp, `window.__moviraServices.engine.getTracks().then(t => JSON.stringify({ s: t.subs.map(x => x.language) }))`));
      info(`mkv embedded subtitles: ${JSON.stringify(subTracks.s)}`);
      const v0 = await probe();
      info(`subtitles before V: ${JSON.stringify(v0.labels)}`);
      await key('v');
      const v1 = await probe();
      info(`after V: ${JSON.stringify(v1.labels)}`);
      ok('V turns on a real subtitle track', v1.labels.length === 1, JSON.stringify(v1.labels));
      await key('v');
      const v2 = await probe();
      info(`after V x2: ${JSON.stringify(v2.labels)}`);
      ok('V moves to the NEXT subtitle track', JSON.stringify(v2.labels) !== JSON.stringify(v1.labels), `${JSON.stringify(v1.labels)} -> ${JSON.stringify(v2.labels)}`);
      await key('v');
      const v3 = await probe();
      info(`after V x3: ${JSON.stringify(v3.labels)}`);
      ok('V cycles through to the next one again', JSON.stringify(v3.labels) !== JSON.stringify(v2.labels), `${JSON.stringify(v2.labels)} -> ${JSON.stringify(v3.labels)}`);
      let off = v3;
      for (let i = 0; i < 6 && off.labels.length > 0; i++) { await key('v'); off = await probe(); }
      ok('V eventually returns to subtitles off', off.labels.length === 0, JSON.stringify(off.labels));
      const stillPlaying = await state(cdp);
      ok('B/V leave playback untouched', !stillPlaying.err && stillPlaying.rs >= 2, JSON.stringify(stillPlaying));
    }

    // ------------------------------------------------------------------
    console.log('\n== Keyboard after panel + fullscreen round trip ==');
    {
      const send = async (k) => { await evalJs(cdp, `(() => { const e = new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return 1; })()`); await sleep(700); };
      const cls = () => evalJs(cdp, `document.querySelector('.video-host').className`);
      const c0 = await cls();
      await send('c');
      const c1 = await cls();
      ok('C changes the video scaling', c0 !== c1, `${c0} -> ${c1}`);
      await send('c'); await send('c');
      const zoomBack = await cls();
      ok('C cycles back', zoomBack === c0, `${zoomBack}`);
      const volBefore = await evalJs(cdp, `document.querySelector('video').volume`);
      await send('ArrowUp');
      const volAfter = await evalJs(cdp, `document.querySelector('video').volume`);
      ok('ArrowUp raises volume', volAfter > volBefore, `${volBefore} -> ${volAfter}`);
      await send('m');
      const muted = await evalJs(cdp, `document.querySelector('video').muted`);
      ok('M toggles mute', muted === true, `muted=${muted}`);
      await send('m');
      await send('f');
      await sleep(1200);
      ok('F enters fullscreen', JSON.parse(await evalJs(cdp, `JSON.stringify({ fs: !!document.querySelector('.player-view.fullscreen') })`)).fs === true);
      await send(' ');
      const fsPaused = await state(cdp);
      ok('Space still works in fullscreen', fsPaused.paused === true, JSON.stringify(fsPaused));
      await send(' ');
      await send('Escape');
      await sleep(1200);
      ok('Escape leaves fullscreen', JSON.parse(await evalJs(cdp, `JSON.stringify({ fs: !!document.querySelector('.player-view.fullscreen') })`)).fs === false);
      // Panel + shortcut combination.
      await evalJs(cdp, `(() => { const b = Array.from(document.querySelectorAll('.topbar .btn.topbar-nav')).find((x) => x.textContent.trim() === 'Settings'); b.click(); return 1; })()`);
      await sleep(500);
      const vol2 = await evalJs(cdp, `document.querySelector('video').volume`);
      await send('ArrowUp');
      const vol3 = await evalJs(cdp, `document.querySelector('video').volume`);
      ok('shortcuts work while a panel is open', vol3 > vol2, `${vol2} -> ${vol3}`);
      await evalJs(cdp, `(() => { const b = Array.from(document.querySelectorAll('.topbar .btn.topbar-nav')).find((x) => x.textContent.trim() === 'Now Playing'); b.click(); return 1; })()`);
      await sleep(400);
    }

    // ------------------------------------------------------------------
    console.log('\n== Tier 1 (mp4): the same interaction story ==');
    {
      ok('mp4 opens and plays', await playPath(cdp, mp4, 'mp4'));
      await resetLag(cdp);
      const before = await state(cdp);
      await sleep(4000);
      const mid = await state(cdp);
      const lag = await readLag(cdp);
      info(`tier 1 steady: longTasks=${lag.n} max=${lag.max}ms, ft ${before.ft} -> ${mid.ft}`);
      ok('tier 1 advances', mid.ft > before.ft + 2.5);
      ok('tier 1 has no long task over 250ms', lag.max < 250, `max=${lag.max}ms`);
      const d2 = mid.durHint || 240;
      await resetLag(cdp);
      const x = Math.round((await centre(cdp, '.timeline')).x);
      const y = Math.round((await centre(cdp, '.timeline')).y);
      const box = JSON.parse(await evalJs(cdp, `(() => { const r = document.querySelector('.timeline').getBoundingClientRect(); return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height }); })()`));
      const tx = Math.round(box.l + box.w * 0.7), ty = Math.round(box.t + box.h / 2);
      const t0 = Date.now();
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tx, y: ty });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', clickCount: 1, buttons: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1, buttons: 1 });
      const hit = await waitAt(cdp, 0.7 * d2, 2.0, 15000);
      const lag2 = await readLag(cdp);
      info(`tier 1 seek to 70%: ${hit.missed ? 'MISSED' : hit.ms + 'ms'}, longTasks=${lag2.n} max=${lag2.max}ms`);
      ok('tier 1 seek lands fast and responsive', !hit.missed && lag2.max < 400, `${hit.ms}ms max=${lag2.max}ms`);
      await realDrag(cdp, 0.3, 0.4);
      const hit2 = await waitAt(cdp, 0.4 * d2, 2.5, 15000);
      ok('tier 1 drag lands', !hit2.missed, `${hit2.ms}ms ft=${hit2.s && hit2.s.ft}`);
      const st = await state(cdp);
      ok('tier 1 still playing after click + drag', !st.paused && !st.err, JSON.stringify(st));
    }

    // ------------------------------------------------------------------
    console.log('\n== Stop -> Play ==');
    {
      await realClick(cdp, '.left button[title="Stop"]');
      await sleep(1500);
      const stopped = await state(cdp);
      ok('Stop pauses and detaches', stopped.paused === true, JSON.stringify(stopped));
      await realClick(cdp, '.play-btn');
      const back = await waitPlaying(cdp, 25000);
      ok('Play after Stop restarts cleanly', !!back, JSON.stringify(back));
      await sleep(2500);
      const st = await state(cdp);
      ok('playback advances after Stop -> Play', st.ft > (back ? back.ft : 0), `${back && back.ft} -> ${st.ft}`);
    }

    ok('no renderer exceptions during the whole run', cdp.logs.length === 0, cdp.logs.slice(0, 3).join(' | '));
    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    try { child.kill(); } catch { /* ignore */ }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });