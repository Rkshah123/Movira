/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * E2E: stop/play recovery + file-association open.
 *  1. Launch the app WITH a media file argument (simulates "Open with" Movira).
 *     Expect: playback starts automatically.
 *  2. engine.stop() then engine.play(): expect playback restarts from the
 *     beginning (regression: Play used to do nothing after Stop).
 *  3. Launch a second instance with another file (simulates double-clicking a
 *     file in Explorer while Movira runs). Expect: the first window plays it.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-stop-'));
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
  throw new Error('page not found');
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  return new Cdp(ws);
}

async function main() {
  const file1 = gen('movie1.mp4', ['-i', 'testsrc=size=320x240:rate=25:duration=30', '-i', 'sine=frequency=440:duration=30,volume=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'mp4']);
  const file2 = gen('movie2.mp4', ['-i', 'testsrc=size=320x240:rate=25:duration=30', '-i', 'sine=frequency=550:duration=30,volume=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'mp4']);

  console.log('Launching app with a file argument (simulates "Open with" Movira)...');
  const child = spawn(electron, ['.', file1, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: path.join(__dirname, '..'),      env: { ...process.env, MOVIRA_USER_DATA_DIR: profileDir() },

    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    const cdp = await connect(await waitForPage(CDP_PORT));

    // 1) Association launch: services ready + video actually playing file1.
    let st = '';
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      st = await evalJs(cdp, `(() => {
        const s = window.__moviraServices;
        const v = document.querySelector('video');
        if (!s || !v) return JSON.stringify({ ready: false });
        return JSON.stringify({ ready: true, path: s.player.getCurrent()?.path ?? null, t: v.currentTime, rs: v.readyState, p: v.paused });
      })()`);
      const o = JSON.parse(st);
      if (o.ready && o.path === file1 && o.rs >= 3 && !o.p && o.t > 0.5) break;
    }
    const o1 = JSON.parse(st);
    ok('"Open with Movira" launch plays the file automatically', o1.ready && o1.path === file1 && o1.rs >= 3 && !o1.p && o1.t > 0.5, JSON.stringify(o1));

    // 2) Stop → Play must restart from the beginning.
    await evalJs(cdp, `(async () => { await window.__moviraServices.engine.stop(); return 'stopped'; })()`);
    await sleep(600);
    const stopped = JSON.parse(await evalJs(cdp, `(() => {
      const v = document.querySelector('video');
      return JSON.stringify({ src: !!v?.src, p: v?.paused ?? true });
    })()`));
    ok('stop() detaches the source', !stopped.src && stopped.p, JSON.stringify(stopped));

    await evalJs(cdp, `(async () => { await window.__moviraServices.engine.play(); return 'played'; })()`);
    let restarted = null;
    for (let i = 0; i < 50; i++) {
      await sleep(250);
      restarted = JSON.parse(await evalJs(cdp, `(() => {
        const v = document.querySelector('video');
        return JSON.stringify({ src: !!v?.src, t: v?.currentTime ?? 0, rs: v?.readyState ?? 0, p: v?.paused ?? true });
      })()`));
      if (restarted.src && restarted.rs >= 3 && !restarted.p) break;
    }
    ok('Play after Stop restarts the video from the beginning', !!restarted && restarted.src && restarted.rs >= 3 && !restarted.p && restarted.t < 5, JSON.stringify(restarted));

    // 3) Second instance with another file hands it to the running window.
    console.log('Launching a second instance with another file (simulates Explorer double-click)...');
    const child2 = spawn(electron, ['.', file2], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, MOVIRA_USER_DATA_DIR: profileDir() },
      stdio: 'ignore',
      windowsHide: true,
    });
    let handedOff = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const cur = await evalJs(cdp, `(() => {
        const s = window.__moviraServices;
        const v = document.querySelector('video');
        return JSON.stringify({ path: s?.player.getCurrent()?.path ?? null, t: v?.currentTime ?? 0, p: v?.paused ?? true });
      })()`);
      const co = JSON.parse(cur);
      if (co.path === file2 && !co.p && co.t > 0.3) { handedOff = true; break; }
    }
    ok('second-instance file open plays in the running window', handedOff);
    try { child2.kill(); } catch { /* gone */ }

    await cdp.ws.close?.();
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
