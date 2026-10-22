/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Ground-truth diagnostic against the PACKAGED binary (release/win-unpacked),
 * which is what the user actually runs. test-playback-lag.cjs launches
 * `electron .` (the dev build), so it can never catch a packaging/window
 * difference.
 *
 * For each interesting point it reports:
 *   - what element is actually under the cursor (elementFromPoint),
 *   - whether that element is inside .player-view (i.e. whether a bubbling
 *     wheel could reach the volume listener AT ALL),
 *   - the real el.volume before/after a trusted wheel gesture,
 *   - forward/backward seek latency and whether load()/src were touched.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ffmpeg = require('ffmpeg-static');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Movira.exe');
const CDP_PORT = 9700 + (process.pid % 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = () => path.join(os.tmpdir(), `movira-diag-packed-${process.pid}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-diag-'));
function gen(file, args) {
  const out = path.join(tmp, file);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out], { timeout: 300000 });
  return out;
}
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
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(m.error.message + ' [' + method + ']')) : res(m.result)));
      setTimeout(() => rej(new Error('CDP timeout: ' + method)), 120000);
    });
  }
}
async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('renderer: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

/** Everything the wheel needs, in one shot, for a given CSS point. */
const PROBE = (x, y) => `(() => {
  const el = document.elementFromPoint(${x}, ${y});
  const v = document.querySelector('video');
  const path = [];
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    path.push(n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : ''));
  }
  return JSON.stringify({
    at: el ? (el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : '')) : null,
    inPlayerView: !!(el && el.closest && el.closest('.player-view')),
    chain: path.slice(0, 5),
    vol: v ? +v.volume.toFixed(3) : null,
    muted: v ? v.muted : null,
    pa: v ? +v.paused : null,
  });
})()`;

async function box(cdp, sel) {
  return JSON.parse(await evalJs(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height) });
  })()`));
}

async function send(cdp, method, params) {
  try { return await cdp.send(method, params); }
  catch (e) { console.log(`     [cdp ${method} failed: ${e.message}]`); return null; }
}

async function wheelAt(cdp, x, y, deltaY) {
  await send(cdp, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(80);
  await send(cdp, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, pointerType: 'mouse' });
  await sleep(400);
}

async function main() {
  console.log('Packaged exe:', EXE, fs.existsSync(EXE) ? '(found)' : '(MISSING)');
  console.log('Generating a 60s mp4 (muted)...');
  const mp4 = gen('d.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60,volume=0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-b:v', '1200k',
    '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4',
  ]);
  // MPEG-TS / mpeg2video: Chromium can neither demux nor decode it, so this
  // ALWAYS takes the ffmpeg -> fragmented MP4 -> MSE path — the only path where
  // the forward buffer window matters.
  const ts = gen('d.ts', [
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=240',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=240,volume=0',
    '-c:v', 'mpeg2video', '-b:v', '2500k', '-c:a', 'aac', '-b:a', '128k',
    '-f', 'mpegts',
  ]);

  const child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT,
    env: { ...process.env, MOVIRA_USER_DATA_DIR: profileDir() },
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
    console.log('page url:', page.url);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);

    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(500);
      ready = await evalJs(cdp, `!!(window.__moviraTestPlay && window.__moviraServices)`).catch(() => false);
    }
    if (!ready) throw new Error('renderer never became ready');
    console.log('renderer ready\n');

    // Load media — the hook takes an ITEM OBJECT, not a bare path.
    await evalJs(cdp, `(() => {
      window.__moviraTestPlay([{ id: 'diag-1', type: 'video', title: 'diag', path: ${JSON.stringify(mp4)} }], 0);
      return 'ok';
    })()`);
    let playing = false;
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      const s = await evalJs(cdp, `(() => { const v=document.querySelector('video'); return JSON.stringify({ rs: v ? v.readyState : -1, p: v ? v.paused : null, e: v && v.error ? v.error.code : null }); })()`);
      const st = JSON.parse(s);
      if (st.rs >= 3 && st.p === false) { playing = true; break; }
    }
    console.log('media playing:', playing);
    await sleep(2000);

    console.log('\n== video element reality check ==');
    console.log(await evalJs(cdp, `(() => {
      const v = document.querySelector('video');
      if (!v) return 'NO VIDEO ELEMENT';
      const host = v.parentElement;
      return JSON.stringify({
        className: v.className,
        hostClass: host ? host.className : null,
        videoWidth: v.videoWidth, videoHeight: v.videoHeight,
        readyState: v.readyState, paused: v.paused,
        src: v.currentSrc.slice(0, 60),
        hasClassMoviraVideo: v.classList.contains('movira-video'),
      }, null, 1);
    })()`));

    console.log('== viewport ==');
    console.log(await evalJs(cdp, `JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent.slice(0,60) })`));

    console.log('\n== DOM shape of the player ==');
    console.log(await evalJs(cdp, `(() => {
      const pv = document.querySelector('.player-view');
      const v = document.querySelector('video');
      const r = pv ? pv.getBoundingClientRect() : null;
      const vr = v ? v.getBoundingClientRect() : null;
      return JSON.stringify({
        playerViewExists: !!pv,
        playerViewRect: r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
        videoRect: vr ? { x: Math.round(vr.left), y: Math.round(vr.top), w: Math.round(vr.width), h: Math.round(vr.height) } : null,
        videoInsidePlayerView: !!(pv && v && pv.contains(v)),
        transportExists: !!document.querySelector('.transport'),
        volumeZoneExists: !!document.querySelector('.volume-zone'),
        sliderExists: !!document.querySelector('.volume-slider'),
      });
    })()`));

    // Start from a mid level, muted off.
    await evalJs(cdp, `(() => { const v=document.querySelector('video'); v.muted=false; v.volume=0.5; v.dispatchEvent(new Event('volumechange')); return 1; })()`);
    await sleep(500);

    const points = [
      ['video centre', null],
      ['volume slider', '.volume-slider'],
      ['volume button', '.volume-zone button'],
      ['transport bar (empty area)', '.controls-row .right select'],
      ['now-playing meta', '.now-playing-meta'],
    ];

    console.log('\n== wheel: what is under the cursor, and does the volume move? ==');
    for (const [label, sel] of points) {
      let x, y;
      if (sel) {
        const b = await box(cdp, sel);
        if (!b || b === 'null' || !b.w) { console.log(`\n  ${label}: SELECTOR NOT FOUND`); continue; }
        x = b.x; y = b.y;
      } else {
        const b = await box(cdp, 'video');
        if (!b || b === 'null' || !b.w) { console.log('\n  video centre: NO VIDEO'); continue; }
        x = b.x; y = b.y;
      }
      const pre = JSON.parse(await evalJs(cdp, PROBE(x, y)));
      const volBefore = pre.vol;
      await wheelAt(cdp, x, y, -120);
      const post = JSON.parse(await evalJs(cdp, PROBE(x, y)));
      const moved = post.vol !== null && volBefore !== null && post.vol > volBefore + 0.001;
      const osd = JSON.parse(await evalJs(cdp, `(() => { const n = document.querySelector('.volume-osd'); return JSON.stringify({ exists: !!n, showing: !!(n && n.classList.contains('show')), text: n ? n.textContent : '' }); })()`));
      console.log(`\n  ${label}  @${x},${y}`);
      console.log(`     elementFromPoint : ${pre.at}`);
      console.log(`     inside .player-view (wheel can bubble to listener): ${pre.inPlayerView}`);
      console.log(`     chain            : ${(pre.chain || []).join(' < ')}`);
      console.log(`     volume           : ${volBefore} -> ${post.vol}   ${moved ? 'CHANGED ok' : '*** NO CHANGE ***'}`);
      console.log(`     OSD              : ${osd.exists ? (osd.showing ? 'SHOWING' : 'present, hidden') + ' "' + osd.text + '"' : '*** MISSING ***'}`);
    }

    console.log('\n== forward / backward buttons ==');
    const fbtns = await evalJs(cdp, `(() => {
      const out = [];
      document.querySelectorAll('.left button').forEach((b, i) => out.push(i + ':' + (b.getAttribute('title') || b.textContent)));
      return JSON.stringify(out);
    })()`);
    console.log('  transport buttons:', fbtns);

    const seekInfo = await evalJs(cdp, `(() => {
      const w = window;
      if (!w.__sp) {
        w.__sp = { load: 0, src: 0 };
        const L = HTMLMediaElement.prototype.load;
        HTMLMediaElement.prototype.load = function () { w.__sp.load++; return L.call(this); };
        const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
        Object.defineProperty(HTMLMediaElement.prototype, 'src', { get() { return d.get.call(this); }, set(v) { w.__sp.src++; return d.set.call(this, v); }, configurable: true });
      }
      return 'ok';
    })()`);
    void seekInfo;

    const readFt = () => evalJs(cdp, `+window.__moviraServices.engine.currentFileTime().toFixed(2)`);
    const readSp = () => evalJs(cdp, `JSON.stringify(window.__sp)`);

    for (const [label, sel, sign] of [['FORWARD skip (next)', '.left button[title^="Next"]', 1], ['BACKWARD skip (prev)', '.left button[title^="Previous"]', -1]]) {
      const b = await box(cdp, sel);
      if (!b || b === 'null') { console.log(`  ${label}: NOT FOUND`); continue; }
      // Park mid-timeline so a 10s skip cannot be confused with a clamp.
      await evalJs(cdp, `(async () => { await window.__moviraServices.engine.seek(25); return 1; })()`);
      await sleep(1200);
      const t0 = Date.now();
      const before = await readFt();
      const sp0 = JSON.parse(await readSp());
      await send(cdp, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
      await send(cdp, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 });
      await send(cdp, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 });
      // Wait until the playhead actually lands (expected ~10s in that direction).
      const want = before + sign * 10;
      let after = before, landed = false;
      for (let i = 0; i < 24; i++) {
        await sleep(150);
        after = await readFt();
        if (Math.abs(after - want) < 3.5) { landed = true; break; }
      }
      const ms = Date.now() - t0;
      const sp1 = JSON.parse(await readSp());
      console.log(`  ${label}: ${before}s -> ${after}s (want ~${want}) in ${ms}ms  ${landed ? 'ok' : '*** DID NOT SKIP ***'}`);
      console.log(`     load() calls: ${sp1.load - sp0.load}, src sets: ${sp1.src - sp0.src}  ${sp1.load === sp0.load && sp1.src === sp0.src ? '(no reload, correct)' : '*** RELOADED THE MEDIA ***'}`);
    }

    // Repeated skips must stay responsive.
    console.log('\n== 8 rapid skips (responsiveness) ==');
    {
      const nb = await box(cdp, '.left button[title^="Next"]');
      const t0 = Date.now();
      for (let i = 0; i < 8; i++) {
        await send(cdp, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: nb.x, y: nb.y, button: 'left', clickCount: 1, buttons: 1 });
        await send(cdp, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: nb.x, y: nb.y, button: 'left', clickCount: 1, buttons: 1 });
        await sleep(60);
      }
      await sleep(1500);
      const ft = await readFt();
      const st = await evalJs(cdp, `(() => { const v=document.querySelector('video'); return JSON.stringify({ rs: v.readyState, err: v.error ? v.error.code : null, paused: v.paused }); })()`);
      console.log(`  8 skips dispatched in ${Date.now() - t0}ms, ft now ${ft}, element ${st}`);
    }

    // Keyboard forward/back (arrow keys) for comparison.
    console.log('\n== keyboard arrow seek (same underlying path) ==');
    for (const k of ['ArrowRight', 'ArrowLeft']) {
      const before = await readFt();
      await evalJs(cdp, `(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })); return 1; })()`);
      let after = before, moved = false;
      for (let i = 0; i < 16; i++) { await sleep(200); after = await readFt(); if (Math.abs(after - before) > 1.5) { moved = true; break; } }
      console.log(`  ${k}: ${before}s -> ${after}s ${moved ? 'ok' : '*** DID NOT MOVE ***'}`);
    }

    console.log('\n== tier 2 (mpeg-ts / MSE): the forward window must stay bounded ==');
    {
      await evalJs(cdp, `(() => {
        window.__moviraTestPlay([{ id: 'diag-ts', type: 'video', title: 'diag ts', path: ${JSON.stringify(ts)} }], 0);
        return 'ok';
      })()`);
      let ok2 = false;
      for (let i = 0; i < 80; i++) {
        await sleep(500);
        const s = JSON.parse(await evalJs(cdp, `(() => { const v=document.querySelector('video'); return JSON.stringify({ rs: v?v.readyState:-1, p: v?v.paused:null }); })()`));
        if (s.rs >= 3 && s.p === false) { ok2 = true; break; }
      }
      console.log('  tier 2 playing:', ok2);
      if (ok2) {
        const readAhead = () => evalJs(cdp, `(() => { const d = window.__moviraMseDebug; const v = document.querySelector('video'); const b = v.buffered; return JSON.stringify({ ahead: d ? +d.bufferedAheadSec().toFixed(1) : -1, bufEnd: b.length ? +b.end(b.length-1).toFixed(1) : 0, bytes: d ? d.byteCount : -1, ft: +window.__moviraServices.engine.currentFileTime().toFixed(1), tier2: window.__moviraServices.engine.isFallbackBusy() ? 1 : 0 }); })()`);
        for (const wait of [3000, 4000, 5000]) {
          await sleep(wait);
          console.log('   ', await readAhead());
        }
        // A skip must land fast on tier 2 as well.
        const nb = await box(cdp, '.left button[title^="Next"]');
        const ftBefore = JSON.parse(await readAhead()).ft;
        const t0 = Date.now();
        await send(cdp, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: nb.x, y: nb.y, button: 'left', clickCount: 1, buttons: 1 });
        await send(cdp, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: nb.x, y: nb.y, button: 'left', clickCount: 1, buttons: 1 });
        let landed = null;
        for (let i = 0; i < 40; i++) {
          await sleep(150);
          const st = JSON.parse(await readAhead());
          if (Math.abs(st.ft - (ftBefore + 10)) < 3.5) { landed = { ms: Date.now() - t0, ...st }; break; }
        }
        console.log(`   tier 2 forward skip: ${ftBefore}s -> ${landed ? landed.ft + 's in ' + landed.ms + 'ms' : '*** DID NOT SKIP ***'}`);
        // The wheel must still work with the MSE pipeline running.
        const vc = await box(cdp, 'video');
        const vBefore = JSON.parse(await evalJs(cdp, `JSON.stringify({ v: document.querySelector('video').volume })`)).v;
        await wheelAt(cdp, vc.x, vc.y, -120);
        const vAfter = JSON.parse(await evalJs(cdp, `JSON.stringify({ v: document.querySelector('video').volume })`)).v;
        console.log(`   wheel over video while tier 2 buffers: ${vBefore} -> ${vAfter} ${vAfter > vBefore + 0.001 ? 'ok' : '*** NO CHANGE ***'}`);
      }
    }

    console.log('\n== renderer exceptions ==');
    console.log(cdp.errs.length ? cdp.errs.slice(0, 5).join('\n') : '  (none)');
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(profileDir(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('DIAG FAILED:', e.message); process.exit(1); });
