/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Why does a tier-2 file fail to play?
 *
 * heavy-dvd.mkv (mpeg2video + AC3 5.1 in MKV — a DVD-style rip, one of the most
 * common "movie" shapes there is) never reaches playback, while direct ffmpeg
 * with the exact same arguments produces a valid fragmented MP4 in seconds.
 * So the breakage is in the pipeline, not in ffmpeg.
 *
 * This captures the MAIN process log (the stream server logs every session,
 * its mode, its exit code and ffmpeg's stderr tail) alongside the renderer's
 * view of the same moment, so the two can be lined up.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Movira.exe');
const MEDIA = path.join(ROOT, 'testmedia');
const CDP_PORT = 9500 + (process.pid % 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = () => path.join(os.tmpdir(), `movira-t2-${process.pid}`);

const file = process.argv[2] || 'heavy-dvd.mkv';
const full = path.join(MEDIA, file);

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
const ev = async (cdp, e) => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('renderer: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

(async () => {
  console.log('file:', full, fs.existsSync(full) ? '(' + (fs.statSync(full).size / 1073741824).toFixed(2) + ' GB)' : '(MISSING)');
  const prof = profileDir();
  const logs = [];
  // Capture stdout/stderr of the PACKAGED app: the stream server logs
  // "[movira:stream] ..." lines there, and they are the only record of what
  // ffmpeg was asked to do and how it exited.
  const child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT, env: { ...process.env, MOVIRA_USER_DATA_DIR: prof },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tap = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) logs.push(line.trim());
  };
  child.stdout.on('data', tap);
  child.stderr.on('data', tap);

  try {
    let page = null;
    for (let i = 0; i < 90 && !page; i++) {
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
    for (let i = 0; i < 60; i++) { await sleep(500); if (await ev(cdp, `!!(window.__moviraTestPlay && window.__moviraServices)`).catch(() => false)) break; }

    // What does the engine's own probe/plan say about this file?
    console.log('\n== probe / plan ==');
    console.log(await ev(cdp, `(async () => {
      const svc = window.__moviraServices;
      const p = svc.api.probeMedia ? await svc.api.probeMedia(${JSON.stringify(full)}) : 'no api.probeMedia';
      const caps = [];
      const el = document.querySelector('video');
      for (const c of ['aac','mp3','ac-3']) caps.push(c + '=' + JSON.stringify(el.canPlayType('audio/mp4; codecs="' + c + '"')));
      for (const c of ['avc1.640029','vp8']) caps.push(c + '=' + JSON.stringify(el.canPlayType('video/mp4; codecs="' + c + '"')));
      return JSON.stringify({ probe: p, caps }, null, 1);
    })()`).catch((e) => 'ERR ' + e.message));

    console.log('\n== open ==');
    await ev(cdp, `(() => { window.__moviraTestPlay([{ id: 't2', type: 'video', title: ${JSON.stringify(file)}, path: ${JSON.stringify(full)} }], 0); return 1; })()`);

    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const s = await ev(cdp, `(() => {
        const v = document.querySelector('video');
        const e = window.__moviraServices.engine;
        const d = window.__moviraMseDebug;
        return JSON.stringify({
          rs: v ? v.readyState : -1, paused: v ? v.paused : null,
          err: v && v.error ? v.error.code + ':' + (v.error.message || '') : null,
          src: v ? v.currentSrc.slice(0, 90) : null,
          netState: v ? v.networkState : -1,
          ct: v && v.error ? '' : '',
          ft: +e.currentFileTime().toFixed(2), known: +e.knownDuration().toFixed(1),
          tier2: e.isFallbackBusy(), restarting: e.isRestarting(),
          mse: d ? { gotInit: d.appendCount > 0, appends: d.appendCount, bytes: d.byteCount, errors: d.appendErrors, fetchFailed: d.fetchFailed, done: d.fetchDone } : null,
        });
      })()`).catch((e) => 'ERR ' + e.message);
      console.log(`  t=${(i + 1) * 2}s  ${s}`);
      const ok = /"rs":[3-9]/.test(s) && /"paused":false/.test(s);
      if (ok) { console.log('  -> PLAYING'); break; }
    }

    console.log('\n== main process log (movira lines) ==');
    const m = logs.filter((l) => /movira|stream|ffmpeg|error|Error/.test(l));
    console.log(m.length ? m.slice(0, 40).join('\n') : '(no matching lines; raw tail below)\n' + logs.slice(-25).join('\n'));

    console.log('\n== renderer exceptions ==');
    console.log(cdp.errs.length ? cdp.errs.slice(0, 6).join('\n') : '(none)');
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await sleep(1500);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(0);
})().catch((e) => { console.error('DIAG FAILED:', e.stack); process.exit(1); });