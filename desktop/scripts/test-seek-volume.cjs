/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * E2E regression: VLC-class seeking + mouse volume control.
 *
 * Guards the behaviors fixed in the playback overhaul (must stay fixed):
 *  - dragging the timeline is PREVIEW-ONLY on the fallback tier: the decoder is
 *    never restarted mid-gesture (proved via a stable window.__moviraMseDebug
 *    identity across the whole drag) and the exact release position lands once
 *  - rapid clicks at different positions never stack ffmpeg pipelines (gate)
 *    and always converge on the last clicked position with playback running
 *  - single clicks remain exact (keeps test-seek-ui.cjs's guarantee on tier 2)
 *  - volume: dragging the slider ball tracks the cursor in real time, wheel
 *    over the volume zone steps it smoothly, wheel over the TIMELINE changes
 *    nothing, and the indicator reads back the applied element volume.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-seekvol-'));
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

async function main() {
  // 90s MPEG-TS: forces the tier-2 ffmpeg→MSE pipeline for every seek test.
  const ts = gen('movie.ts', ['-i', 'testsrc=size=320x240:rate=25:duration=90', '-i', 'sine=frequency=550:duration=90,volume=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts']);

  console.log('Launching Electron app...');
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, MOVIRA_USER_DATA_DIR: profileDir() },
    stdio: 'ignore',
    windowsHide: true,
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

    // Load through the same path the UI uses.
    console.log('Waiting for services + loading tier-2 test file...');
    let loaded = 'no services hook';
    for (let i = 0; i < 40; i++) {
      loaded = await evalJs(cdp, `(async () => {
        const s = window.__moviraServices;
        if (!s) return 'no services hook';
        const item = { id: 't1', type: 'video', title: 'seekvol-test', path: ${JSON.stringify(ts)} };
        window.__moviraTestPlay([item], 0);
        return 'loaded';
      })()`);
      if (loaded === 'loaded') break;
      await sleep(500);
    }
    ok('video loaded through engine', loaded === 'loaded', loaded);

    // Wait for tier-2 playback (frames flowing via MSE).
    let playing = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const st = await evalJs(cdp, `(() => {
        const v = document.querySelector('video');
        return v ? JSON.stringify({ rs: v.readyState, p: v.paused, blob: (v.src || '').startsWith('blob:') }) : 'no-video';
      })()`);
      if (st !== 'no-video') {
        const o = JSON.parse(st);
        if (o.rs >= 3 && !o.p && o.blob) { playing = true; break; }
      }
    }
    ok('tier-2 (MSE) playback running', playing);

    // ------------------------------------------------------------------
    // 1) DRAG: preview-only on tier 2 (no decoder restarts), exact landing
    // ------------------------------------------------------------------
    console.log('\n== Timeline drag: preview-only, no mid-drag decoder restarts ==');
    const dragRes = JSON.parse(await evalJs(cdp, `(async () => {
      const tl = document.querySelector('.timeline');
      const v = document.querySelector('video');
      if (!tl || !v) return JSON.stringify({ fatal: 'no timeline/video' });
      let dur = v.duration;
      for (let i = 0; i < 30 && (!isFinite(dur) || dur <= 0); i++) {
        await new Promise((r) => setTimeout(r, 100));
        dur = (document.querySelector('video') || {}).duration;
      }
      if (!isFinite(dur) || dur <= 0) return JSON.stringify({ fatal: 'no duration' });
      const rect = tl.getBoundingClientRect();
      const x0 = rect.left + rect.width * 0.10;
      const x1 = rect.left + rect.width * 0.72;
      const y = rect.top + rect.height / 2;
      const eng = window.__moviraServices.engine;
      const mseBefore = window.__moviraMseDebug;
      const t0 = performance.now();
      let intermediate = [];
      const hit = document.elementFromPoint(x0, y);
      const el = hit && hit.closest && hit.closest('.timeline') ? hit : tl;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x0, clientY: y, pointerId: 21, pointerType: 'mouse', button: 0, isPrimary: true }));
      // Drag in 12 steps (~480ms total) toward 72% of the file.
      for (let i = 1; i <= 12; i++) {
        const x = x0 + (x1 - x0) * (i / 12);
        el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 21, pointerType: 'mouse', isPrimary: true }));
        if (i % 3 === 0) intermediate.push(+eng.currentFileTime().toFixed(1));
        await new Promise((r) => setTimeout(r, 40));
      }
      const mseAfterDrag = window.__moviraMseDebug;
      // Settle check: still the SAME instance while the release commit runs.
      await new Promise((r) => setTimeout(r, 250));
      const mseAtCommit = window.__moviraMseDebug;
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x1, clientY: y, pointerId: 21, pointerType: 'mouse', button: 0, isPrimary: true }));
      const want = 0.72 * dur;
      let landed = null;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const vv = document.querySelector('video');
        const ft = eng ? eng.currentFileTime() : vv.currentTime;
        if (Math.abs(ft - want) < 0.75) { landed = Math.round(performance.now() - t0); break; }
      }
      const vAfter = document.querySelector('video');
      return JSON.stringify({
        want: +want.toFixed(2),
        landedMs: landed,
        paused: vAfter ? vAfter.paused : null,
        advancing: (() => {
          const a = eng.currentFileTime();
          return a;
        })(),
        intermediates: intermediate,
        onePipeline: mseBefore === mseAfterDrag && mseAfterDrag === mseAtCommit,
      });
    })()`));

    if (dragRes.fatal) {
      ok('drag seek gesture', false, dragRes.fatal);
    } else {
      ok('drag: no decoder restart mid-gesture (one MSE pipeline)', dragRes.onePipeline === true, JSON.stringify({ same: dragRes.onePipeline }));
      ok('drag: preview followed the cursor (intermediate positions move forward)',
        dragRes.intermediates.length >= 3 && dragRes.intermediates.every((v, i) => i === 0 || v >= dragRes.intermediates[i - 1] - 1),
        `positions=${dragRes.intermediates.join(',')}`);
      ok('drag: released exactly at 72% of duration', dragRes.landedMs !== null && Math.abs(dragRes.want - 0.72 * 90) < 3 && dragRes.landedMs < 12000, JSON.stringify(dragRes));
      ok('drag: playback keeps running after release', dragRes.paused === false, `paused=${dragRes.paused}`);
    }

    // ------------------------------------------------------------------
    // 2) RAPID CLICKS: 6 positions in quick succession → gate, converges
    // ------------------------------------------------------------------
    console.log('\n== Rapid clicks at different positions: stable + convergent ==');
    const rapid = JSON.parse(await evalJs(cdp, `(async () => {
      const v = document.querySelector('video');
      if (!v) return JSON.stringify({ fatal: 'no video' });
      const dur = v.duration;
      if (!isFinite(dur) || dur <= 0) return JSON.stringify({ fatal: 'no duration' });
      const tl = document.querySelector('.timeline');
      const eng = window.__moviraServices.engine;
      const rect = () => tl.getBoundingClientRect();
      const y = rect().top + rect().height / 2;
      const fracs = [0.85, 0.20, 0.60, 0.35, 0.75, 0.50];
      const t0 = performance.now();
      for (let k = 0; k < fracs.length; k++) {
        const r = rect();
        const x = r.left + r.width * fracs[k];
        const hit = document.elementFromPoint(x, y);
        const el = hit && hit.closest && hit.closest('.timeline') ? hit : tl;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 31 + k, pointerType: 'mouse', button: 0, isPrimary: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 31 + k, pointerType: 'mouse', button: 0, isPrimary: true }));
        await new Promise((r2) => setTimeout(r2, 150));
      }
      const want = fracs[fracs.length - 1] * dur;
      let landed = null;
      let rs = 0;
      for (let i = 0; i < 120; i++) {
        await new Promise((r2) => setTimeout(r2, 100));
        const vv = document.querySelector('video');
        const ft = eng ? eng.currentFileTime() : (vv ? vv.currentTime : -1);
        rs = vv ? vv.readyState : 0;
        if (Math.abs(ft - want) < 0.75) { landed = Math.round(performance.now() - t0); break; }
      }
      // Stability: clock advances afterwards (no freeze), element healthy.
      const tA = eng.currentFileTime();
      await new Promise((r2) => setTimeout(r2, 1500));
      const tB = eng.currentFileTime();
      const vv = document.querySelector('video');
      return JSON.stringify({
        want: +want.toFixed(2), landedMs: landed, rs,
        advancing: tB > tA + 0.5 && vv && !vv.paused && !vv.error,
        err: vv && vv.error ? vv.error.code : null,
      });
    })()`));

    if (rapid.fatal) {
      ok('rapid clicks', false, rapid.fatal);
    } else {
      ok('rapid clicks converged on the LAST clicked position', rapid.landedMs !== null && rapid.landedMs < 20000, JSON.stringify({ want: rapid.want, landedMs: rapid.landedMs }));
      ok('rapid clicks left a stable, advancing player (gate held, no crash)', rapid.advancing && rapid.rs >= 3 && rapid.err === null, JSON.stringify(rapid));
    }

    // ------------------------------------------------------------------
    // 3) VOLUME: drag the slider ball, wheel over volume zone, wheel on
    //    timeline must do nothing
    // ------------------------------------------------------------------
    console.log('\n== Mouse volume control: drag + wheel ==');
    // 3a. Drag the volume ball.
    const volDrag = JSON.parse(await evalJs(cdp, `(async () => {
      const vs = document.querySelector('.volume-slider');
      const v = document.querySelector('video');
      if (!vs || !v) return JSON.stringify({ fatal: 'no volume slider/video' });
      const before = v.volume;
      const rect = vs.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const x0 = rect.left + rect.width * (before > 0.9 ? 0.9 : before) || rect.left + 2;
      const x1 = rect.left + rect.width * 0.25;
      const hit = document.elementFromPoint(x0 === rect.left ? rect.left + 2 : x0, y);
      const el = hit && hit.closest && hit.closest('.volume-slider') ? hit : vs;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x0 || rect.left + 2, clientY: y, pointerId: 41, pointerType: 'mouse', button: 0, isPrimary: true }));
      let seen = [];
      for (let i = 1; i <= 8; i++) {
        const x = x0 + (x1 - x0) * (i / 8);
        el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 41, pointerType: 'mouse', isPrimary: true }));
        seen.push(+v.volume.toFixed(3));
        await new Promise((r) => setTimeout(r, 30));
      }
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x1, clientY: y, pointerId: 41, pointerType: 'mouse', button: 0, isPrimary: true }));
      await new Promise((r) => setTimeout(r, 200));
      const ind = vs.getAttribute('aria-valuenow');
      return JSON.stringify({ before, after: v.volume, seen, ariaNow: ind, muted: v.muted });
    })()`));

    if (volDrag.fatal) {
      ok('volume drag', false, volDrag.fatal);
    } else {
      ok('volume drag: tracks the cursor in real time and lands at 25%',
        volDrag.seen.length === 8 && volDrag.after < 0.30 && volDrag.after > 0.20 && !volDrag.muted,
        JSON.stringify({ before: volDrag.before, after: volDrag.after }));
      ok('volume drag: applied on every move (monotone toward target)',
        volDrag.seen.every((v, i) => i === 0 || v <= volDrag.seen[i - 1] + 1e-9) && volDrag.seen[0] > volDrag.seen[7],
        `seen=${volDrag.seen.slice(0, 3).join(',')}…${volDrag.seen.slice(-2).join(',')}`);
      ok('volume drag: indicator reads the applied volume immediately',
        Number(volDrag.ariaNow) === Math.round(volDrag.after * 100),
        `aria=${volDrag.ariaNow} vol=${volDrag.after}`);
    }

    // 3b. Wheel over the volume zone: steps ±0.05, clamped at edges.
    const volWheel = JSON.parse(await evalJs(cdp, `(async () => {
      const zone = document.querySelector('.volume-zone');
      const v = document.querySelector('video');
      if (!zone || !v) return JSON.stringify({ fatal: 'no volume zone/video' });
      const start = v.volume;
      const rect = zone.getBoundingClientRect();
      const cx = rect.left + Math.min(40, rect.width / 2);
      const cy = rect.top + rect.height / 2;
      const target = zone.querySelector('.volume-slider') || zone;
      const wheel = (dy) => target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: dy, clientX: cx, clientY: cy }));
      // 3 up-steps from ~0.25 → ~0.40, then 20 down-steps → clamped at 0.
      for (let i = 0; i < 3; i++) { wheel(-100); await new Promise((r) => setTimeout(r, 60)); }
      const afterUp = v.volume;
      for (let i = 0; i < 20; i++) { wheel(100); await new Promise((r) => setTimeout(r, 25)); }
      const afterDown = v.volume;
      const mutedAtZero = v.muted; // captured BEFORE any step-up
      // 4 up-steps from 0 → 0.20 (exact step math, no drift).
      for (let i = 0; i < 4; i++) { wheel(-100); await new Promise((r) => setTimeout(r, 60)); }
      const afterReup = v.volume;
      return JSON.stringify({ start, afterUp, afterDown, afterReup, mutedAtZero, unmutedAfterUp: !v.muted });
    })()`));

    if (volWheel.fatal) {
      ok('volume wheel', false, volWheel.fatal);
    } else {
      ok('wheel over volume: steps up by 0.05 per notch', Math.abs(volWheel.afterUp - Math.min(1, volWheel.start + 0.15)) < 0.01, JSON.stringify(volWheel));
      ok('wheel over volume: clamps at 0 (muted) and is audible again on step-up', volWheel.afterDown === 0 && volWheel.mutedAtZero && volWheel.unmutedAfterUp && Math.abs(volWheel.afterReup - 0.20) < 0.01, JSON.stringify(volWheel));
    }

    // 3c. The timeline is part of the PLAYER, so the wheel there controls the
    // volume (VLC behaviour) — and must absolutely never move the playhead.
    const tlWheel = JSON.parse(await evalJs(cdp, `(async () => {
      const tl = document.querySelector('.timeline');
      const v = document.querySelector('video');
      if (!tl || !v) return JSON.stringify({ fatal: 'no timeline/video' });
      const rect = tl.getBoundingClientRect();
      const x = rect.left + rect.width * 0.5;
      const y = rect.top + rect.height / 2;
      const before = v.volume;
      const posBefore = window.__moviraServices ? window.__moviraServices.engine.currentFileTime() : v.currentTime;
      tl.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: x, clientY: y }));
      await new Promise((r) => setTimeout(r, 150));
      const hit = document.elementFromPoint(x, y);
      const over = hit && hit.closest && hit.closest('.timeline') ? true : false;
      const posAfter = window.__moviraServices ? window.__moviraServices.engine.currentFileTime() : v.currentTime;
      return JSON.stringify({ before, after: v.volume, pointerOverTimeline: over, moved: Math.abs(posAfter - posBefore) });
    })()`));
    if (tlWheel.fatal) {
      ok('wheel over timeline', false, tlWheel.fatal);
    } else {
      ok('wheel over the timeline raises the volume (it is part of the player)', tlWheel.after > tlWheel.before, JSON.stringify(tlWheel));
      ok('wheel over the timeline never seeks', tlWheel.moved < 0.6, `moved ${tlWheel.moved}s`);
    }

    // 3d. Wheel OUTSIDE the player (the top bar) must be left completely alone.
    const outsideWheel = JSON.parse(await evalJs(cdp, `(async () => {
      const bar = document.querySelector('.topbar');
      const v = document.querySelector('video');
      if (!bar || !v) return JSON.stringify({ fatal: 'no topbar/video' });
      const rect = bar.getBoundingClientRect();
      const x = rect.left + rect.width * 0.5;
      const y = rect.top + rect.height / 2;
      const before = v.volume;
      const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: x, clientY: y });
      bar.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, 150));
      const hit = document.elementFromPoint(x, y);
      const overPlayer = !!(hit && hit.closest && hit.closest('.player-view'));
      return JSON.stringify({ before, after: v.volume, overPlayer, notPrevented: ev.defaultPrevented === false });
    })()`));
    if (outsideWheel.fatal) {
      ok('wheel outside the player', false, outsideWheel.fatal);
    } else {
      ok('wheel outside the player does not change the volume', outsideWheel.before === outsideWheel.after, JSON.stringify(outsideWheel));
      ok('wheel outside the player is not hijacked (still scrollable)', outsideWheel.notPrevented === true, JSON.stringify(outsideWheel));
    }

    ws.close();
  } finally {
    child.kill();
    await sleep(400);
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  }

  console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('seek/volume E2E crashed:', e); process.exit(1); });
