/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Diagnose the packaged app's ffmpeg fallback tier: probe + startStream + the
 * surfaced error message, evaluated in the running packaged renderer.
 */
const { spawn } = require('child_process');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ffmpeg = require('ffmpeg-static');
const CDP_PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      setTimeout(() => reject(new Error('CDP timeout')), 60000);
    });
  }
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Renderer exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-packdiag-'));
  const ts = path.join(tmp, 'movie.ts');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=550:duration=60,volume=0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50',
    '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts', ts], { timeout: 60000 });

  const exe = path.join(__dirname, '..', 'release', 'win-unpacked', 'Movira.exe');
  const child = spawn(exe, [ts, `--remote-debugging-port=${CDP_PORT}`, '--enable-logging'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, MOVIRA_USER_DATA_DIR: path.join(os.tmpdir(), 'movira-test-profile-diag-packaged') },
  });
  child.stdout.on('data', (d) => console.log('[out]', d.toString().trim().split('\n').join('\n[out] ')));
  child.stderr.on('data', (d) => console.log('[err]', d.toString().trim().split('\n').join('\n[err] ')));

  try {
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
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

    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      ready = await evalJs(cdp, `!!window.__moviraServices`);
      if (ready) break;
    }
    console.log('services ready:', ready);

    const out = JSON.parse(await evalJs(cdp, `(async () => {
      const probe = await window.movira.probeMedia(${JSON.stringify(ts)});
      const stream = await window.movira.startStream({ src: ${JSON.stringify(ts)}, mode: 'remux-tc-audio', seek: 0 });
      const caps = ['avc1','hvc1','vp09','av01'].map((c) => document.createElement('video').canPlayType('video/mp4; codecs="' + c + '"'));
      return JSON.stringify({ probe, stream, caps, toast: document.querySelector('.error-toast')?.textContent ?? null });
    })()`));
    console.log(JSON.stringify(out, null, 2));
  } finally {
    child.kill();
    await sleep(300);
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  }
}

main().catch((e) => { console.error('diag crashed:', e); process.exit(1); });
