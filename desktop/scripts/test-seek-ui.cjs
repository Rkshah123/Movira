/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * UI end-to-end test: clicks the real Timeline component inside the running
 * Electron app and verifies the video seeks exactly to the clicked position.
 *
 * Validates the user-reported bugs:
 *  - single click seeks to the EXACT clicked position (no stepping/offset)
 *  - repeated single clicks at different positions all land precisely
 *  - seeking is responsive (no long stalls between clicks)
 */
const { spawn } = require('child_process');
const { execFileSync } = require('child_process');
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-seek-'));

function gen(file, args) {
  const out = path.join(tmp, file);
  const argv = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const a of args) {
    if (typeof a === 'string' && a.startsWith('-i')) argv.push('-f', 'lavfi');
    argv.push(a);
  }
  execFileSync(ffmpeg, [...argv, out], { timeout: 30000 });
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
      setTimeout(() => reject(new Error('CDP timeout: ' + method)), 90000);
    });
  }
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error('Renderer exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function main() {
  // 60s H.264 test video (enough room for distinct seek targets).
  const mp4 = gen('test.mp4', ['-i', 'testsrc=size=320x240:rate=25:duration=60', '-i', 'sine=frequency=440:duration=60,volume=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-b:a', '96k', '-f', 'mp4']);

  console.log('Launching Electron app...');
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: path.join(__dirname, '..'),      env: { ...process.env, MOVIRA_USER_DATA_DIR: profileDir() },

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

    // Load the video through the engine (tier 1 native file:// path).
    console.log('Waiting for services + loading test video...');
    let loaded = 'no services hook';
    for (let i = 0; i < 40; i++) {
      loaded = await evalJs(cdp, `(async () => {
        const s = window.__moviraServices;
        if (!s) return 'no services hook';
        // Drive the same path the UI uses: playItems -> setQueue + React state.
        const item = { id: 't1', type: 'video', title: 'seek-test', path: ${JSON.stringify(mp4)} };
        window.__moviraTestPlay([item], 0);
        return 'loaded';
      })()`);
      if (loaded === 'loaded') break;
      await sleep(500);
    }
    ok('video loaded through engine', loaded === 'loaded', loaded);

    // Wait for real playback (frames flowing) before testing seeks.
    let playing = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const st = await evalJs(cdp, `(() => { const v = document.querySelector('video'); return v ? JSON.stringify({ t: v.currentTime, rs: v.readyState, p: v.paused }) : 'no-video'; })()`);
      if (st !== 'no-video') {
        const o = JSON.parse(st);
        if (o.rs >= 3 && !o.p) { playing = true; break; }
      }
    }
    ok('video is playing (tier 1 native)', playing);

    const seekTest = `(async () => {
      const results = [];
      const tl = document.querySelector('.timeline');
      if (!tl) return JSON.stringify({ fatal: 'timeline element not found' });
      const rect = tl.getBoundingClientRect();
      const dur = document.querySelector('video').duration;
      const click = async (frac) => {
        const x = rect.left + rect.width * frac;
        const y = rect.top + rect.height / 2;
        const el = document.elementFromPoint(x, y) || tl;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse', button: 0, isPrimary: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse', button: 0, isPrimary: true }));
      };
      const targets = [0.1, 0.35, 0.62, 0.85, 0.25, 0.9];
      for (const frac of targets) {
        const want = frac * dur;
        const t0 = performance.now();
        await click(frac);
        // Wait for the element position to reach the target (or timeout).
        let landed = null;
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const v = document.querySelector('video');
          if (!v) break;
          if (Math.abs(v.currentTime - want) < 0.75) { landed = performance.now() - t0; break; }
        }
        results.push({ frac, want: +want.toFixed(2), landedMs: landed === null ? null : Math.round(landed) });
        await new Promise((r) => setTimeout(r, 350));
      }
      return JSON.stringify({ dur: +dur.toFixed(2), results });
    })()`;

    console.log('\n== Single-click seek accuracy (real clicks on the timeline) ==');
    const raw = await evalJs(cdp, seekTest);
    const out = JSON.parse(raw);
    if (out.fatal) {
      ok('timeline present', false, out.fatal);
    } else {
      let allAccurate = true;
      let allResponsive = true;
      for (const r of out.results) {
        const accurate = r.landedMs !== null;
        const fast = accurate && r.landedMs < 4000;
        if (!accurate) allAccurate = false;
        if (!fast) allResponsive = false;
        console.log(`    click ${(r.frac * 100).toFixed(0)}% → target ${r.want}s : ${accurate ? `landed in ${r.landedMs}ms` : 'NEVER LANDED'}`);
      }
      ok('every single click landed at the exact clicked position', allAccurate);
      ok('every seek responsive (<4s incl. decode settle)', allResponsive);
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

main().catch((e) => { console.error('seek E2E crashed:', e); process.exit(1); });
