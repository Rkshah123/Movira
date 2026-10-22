/* eslint-disable @typescript-eslint/no-var-requires */
/** Probe: launch the app, capture renderer console + basic DOM facts. */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const http = require('http');
const electron = require('electron');
const CDP_PORT = 9343;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        this.logs.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.logs.push('[EXCEPTION] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      }
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      setTimeout(() => reject(new Error('CDP timeout: ' + method)), 30000);
    });
  }
}

async function main() {
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, MOVIRA_USER_DATA_DIR: path.join(os.tmpdir(), 'movira-test-profile-probe-console') },
    stdio: 'ignore', windowsHide: true,
  });
  try {
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      await sleep(1000);
      try {
        const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        page = list.find((t) => t.type === 'page' && /dist[\\/]renderer[\\/]index\.html/.test(t.url));
      } catch { /* retry */ }
    }
    if (!page) throw new Error('no page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await sleep(3000);
    const info = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
      root: !!document.getElementById('root'),
      rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
      bodyLen: document.body.innerHTML.length,
      hasVideo: !!document.querySelector('video'),
      hasTimeline: !!document.querySelector('.timeline'),
      view: (window.__moviraServices ? 'services' : 'noservices'),
      loadingScreen: !!document.querySelector('.loading-screen'),
      playerEmpty: !!document.querySelector('.player-empty'),
    })`, returnByValue: true });
    console.log('DOM:', info.result.value);
    console.log('CONSOLE LOGS (' + cdp.logs.length + '):');
    for (const l of cdp.logs.slice(-40)) console.log('  ' + l);
    ws.close();
  } finally {
    child.kill();
    await sleep(400);
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  }
}
main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
