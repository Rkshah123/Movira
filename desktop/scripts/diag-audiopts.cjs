/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * The audio track of heavy-dvd.mkv (AC3 5.1(side) @ 44.1 kHz) is what Chromium
 * refuses; the same file's video appends fine, and 6-channel AAC produced from
 * a stereo source appends fine. So the question is practical: which ffmpeg
 * audio settings produce an init segment this renderer accepts, WITHOUT
 * throwing away the user's surround sound (downmixing to stereo is not an
 * acceptable "fix").
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Movira.exe');
const MEDIA = path.join(ROOT, 'testmedia');
const ffmpeg = require('ffmpeg-static');
const CDP_PORT = 9380 + (process.pid % 120);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DVD = path.join(MEDIA, 'heavy-dvd.mkv');
const OUT = ['-copyts', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4'];
const VID = ['-map', '0:v:0?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-g', '60'];

const A = ['-map', '0:a:0?'];
const VARIANTS = [
  ['A -ac 6 alone (no layout name)', [...A, '-ac', '6', '-c:a', 'aac', '-b:a', '192k']],
  ['B -ar 48000 alone', [...A, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k']],
  ['C -channel_layout 5.1(side)  (the EXACT source layout)', [...A, '-channel_layout', '5.1(side)', '-c:a', 'aac', '-b:a', '192k']],
  ['D -channel_layout 5.1        (back)', [...A, '-channel_layout', '5.1', '-c:a', 'aac', '-b:a', '192k']],
  ['E -sample_fmt fltp alone', [...A, '-sample_fmt', 'fltp', '-c:a', 'aac', '-b:a', '192k']],
  ['F -channel_layout 5.1 -ar 48000 (belt and braces)', [...A, '-channel_layout', '5.1', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k']],
];

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } });
  }
  send(method, params = {}, ms = 120000) {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-aopt-'));
  const built = [];
  for (const [i, [name, tail]] of VARIANTS.entries()) {
    const f = path.join(dir, `v${i}.mp4`);
    try {
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', DVD, ...VID, ...tail, ...OUT, '-t', '2', f], { timeout: 240000 });
      let info = '';
      try {
        const pr = execFileSync(ffmpeg, ['-hide_banner', '-i', f], { timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
        void pr;
      } catch (e) { info = String(e.stderr || ''); }
      const audio = (info.split('\n').find((l) => l.includes('Audio:')) || '').trim();
      built.push([name, f]);
      console.log(`  built ${name}\n         ${audio.replace(/\s+/g, ' ').slice(0, 110)}`);
    } catch (e) {
      console.log(`  BUILD FAILED ${name}: ${String((e.stderr || e.message)).split('\n').slice(-1)[0].slice(0, 140)}`);
    }
  }

  const srv = http.createServer((req, res) => {
    const f = path.join(dir, path.basename(req.url));
    if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const prof = path.join(os.tmpdir(), `movira-aopt-${process.pid}`);
  const child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT, env: { ...process.env, MOVIRA_USER_DATA_DIR: prof }, stdio: 'ignore', windowsHide: true,
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
    if (!page) throw new Error('page not found');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);
    for (let i = 0; i < 60; i++) { await sleep(500); if (await ev(cdp, `!!(window.__moviraTestPlay)`).catch(() => false)) break; }

    for (const [name, f] of built) {
      const out = await ev(cdp, `(async () => {
        const buf = new Uint8Array(await (await fetch('http://127.0.0.1:${port}/${path.basename(f)}')).arrayBuffer());
        const mimes = ['video/mp4; codecs="avc1.640029, mp4a.40.2"', 'video/mp4; codecs="avc1.640029, mp4a.69"', 'video/mp4; codecs="avc1.640029, mp3"', 'video/mp4; codecs="avc1.640029, opus"', 'video/mp4; codecs="avc1.640029"', 'audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="mp4a.69"', 'audio/mp4; codecs="mp3"', 'audio/mp4; codecs="opus"'];
        const res2 = [];
        for (const mime of mimes) {
          if (!MediaSource.isTypeSupported(mime)) continue;
          const ms = new MediaSource();
          const v = document.createElement('video');
          v.src = URL.createObjectURL(ms);
          try {
            await new Promise((r, j) => { ms.addEventListener('sourceopen', r, { once: true }); setTimeout(() => j(new Error('sourceopen timeout')), 5000); });
            const sb = ms.addSourceBuffer(mime);
            const verdict = await new Promise((r) => {
              sb.addEventListener('error', () => r('REJECTED'), { once: true });
              try { sb.appendBuffer(buf); } catch (e) { return r('threw'); }
              sb.addEventListener('updateend', () => r('OK ' + (sb.buffered.length ? sb.buffered.end(0).toFixed(2) : '?') + 's'), { once: true });
              setTimeout(() => r('timeout'), 5000);
            });
            res2.push(mime.replace('video/mp4; codecs=', '').replace('audio/mp4; codecs=', '') + ' -> ' + verdict);
          } catch (e) { res2.push(mime.slice(10, 50) + ' -> ' + e.message); }
        }
        return res2.length ? res2.join('   |   ') : '(no supported mime)';
      })()`).catch((e) => 'ERR ' + e.message);
      console.log(`\n  ${name}\n    ${out}`);
    }
  } finally {
    srv.close();
    try { child.kill(); } catch { /* ignore */ }
    await sleep(800);
    for (const d of [dir, prof]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  process.exit(0);
})().catch((e) => { console.error('DIAG FAILED:', e.stack); process.exit(1); });