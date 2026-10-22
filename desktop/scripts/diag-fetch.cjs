/* eslint-disable @typescript-eslint/no-var-requires */
/** Diagnostic: capture renderer console + network failures during a fallback fetch. */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ffmpeg = require('ffmpeg-static');
const electron = require('electron');
const CDP_PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-diag-'));

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
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      setTimeout(() => reject(new Error('CDP timeout: ' + method)), 60000);
    });
  }
}

async function main() {
  const ts = gen('test.ts', ['-i', 'testsrc=size=320x240:rate=25:duration=4', '-i', 'sine=frequency=440:duration=4,volume=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts']);

  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: path.join(__dirname, '..'),
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
    if (!page) throw new Error('page not found');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);

    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    const expr = `(async () => {
      const api = window.movira;
      const probe = await api.probeMedia(${JSON.stringify(ts)});
      const mode = await api.decideMode({ videoCodec: probe.videoCodec, audioCodec: probe.audioCodec }, ['aac','mp3'], ['h264']);
      const r = await api.startStream({ src: ${JSON.stringify(ts)}, mode, audioCodec: probe.audioCodec });
      if (!r.ok) return 'startStream failed: ' + r.reason;
      try {
        const res = await fetch(r.url);
        return 'fetch OK status=' + res.status;
      } catch (e) {
        return 'FETCH FAILED: ' + e.message + ' | url=' + r.url;
      }
    })()`;

    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    console.log('RESULT:', r.exceptionDetails ? JSON.stringify(r.exceptionDetails, null, 2) : r.result.value);
    console.log('\n--- url used:', (r.result.value || '').match(/url=(\S+)/)?.[1] ?? 'n/a');

    await sleep(1000);
    console.log('\n=== console/log/network events ===');
    for (const ev of cdp.events) {
      if (ev.method === 'Runtime.consoleAPICalled') {
        console.log('[console.' + ev.params.type + ']', ev.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (ev.method === 'Log.entryAdded') {
        console.log('[log]', ev.params.entry.source, ev.params.entry.level, ev.params.entry.text, ev.params.entry.url ?? '');
      } else if (ev.method === 'Network.loadingFailed') {
        console.log('[network FAIL]', JSON.stringify(ev.params));
      } else if (ev.method === 'Network.responseReceived') {
        console.log('[network resp]', ev.params.response.status, ev.params.response.url.slice(0, 90));
      }
    }
    ws.close();
  } finally {
    child.kill();
    await sleep(400);
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  }
}

main().catch((e) => { console.error('diag crashed:', e); process.exit(1); });
