/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Is the 5.1 rejection about the CHANNEL COUNT, or about AC3 -> AAC?
 *
 * Established so far:
 *   stereo AAC (from heavy-dvd.mkv)  -> appends fine
 *   5.1 AAC   (from heavy-dvd.mkv)   -> SourceBuffer error for EVERY mime,
 *                                        including the video-only mime, which
 *                                        means the init SEGMENT is being
 *                                        rejected, not the audio track itself
 *   video only (no audio)             -> appends fine with a video-only mime
 *
 * So the control that decides it: upmix a file that is known to work to 6
 * channels. If THAT fails, the channel count alone does it. Also tries the
 * practical workarounds (delay_moov, Opus, lower bitrate) so the fix is chosen
 * from measurements rather than from memory.
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
const CDP_PORT = 9400 + (process.pid % 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OK = path.join(MEDIA, 'movie-2.86gb.mkv'); // H.264 + STEREO AAC, known good
const DVD = path.join(MEDIA, 'heavy-dvd.mkv'); // mpeg2video + AC3 5.1, fails
const OUT = ['-copyts', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4'];
const VID = ['-map', '0:v:0?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-g', '60'];

const VARIANTS = [
  // CONTROL: source is known-good stereo, output stays stereo.
  ['control: stereo from good file', OK, [...VID, '-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k']],
  // CONTROL + 1 VARIABLE: identical, except upmixed to 6 channels.
  ['UPMIX stereo -> 6ch AAC', OK, [...VID, '-map', '0:a:0?', '-af', 'pan=5.1|c0=c0|c1=c1|c2=c0|c3=c1|c4=c0|c5=c1', '-c:a', 'aac', '-b:a', '384k']],
  // Same, but 4 channels: separates "more than stereo" from "exactly 6".
  ['upmix stereo -> 4ch AAC', OK, [...VID, '-map', '0:a:0?', '-af', 'pan=4.0|c0=c0|c1=c1|c2=c0|c3=c1', '-c:a', 'aac', '-b:a', '256k']],
  // The real failing file, with delay_moov added.
  ['5.1 + delay_moov', DVD, [...VID, '-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k']],
  // The real failing file, as Opus (Chromium supports Opus in fMP4).
  ['5.1 -> Opus in mp4', DVD, [...VID, '-map', '0:a:0?', '-c:a', 'libopus', '-b:a', '192k']],
  // The real failing file, transcoded to 5.1 but at a generous bitrate.
  ['5.1 AAC @ 448k', DVD, [...VID, '-map', '0:a:0?', '-c:a', 'aac', '-b:a', '448k']],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-5ch-'));
  const built = [];
  for (const [i, [name, src, tail]] of VARIANTS.entries()) {
    const f = path.join(dir, `v${i}.mp4`);
    const flags = name.includes('delay_moov')
      ? [...OUT.slice(0, 1), '-movflags', '+frag_keyframe+empty_moov+default_base_moof+delay_moov', '-f', 'mp4']
      : OUT;
    try {
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, ...tail, ...flags, '-t', '3', f], { timeout: 240000 });
      built.push([name, f]);
      const probe = execFileSync(ffmpeg, ['-hide_banner', '-i', f], { timeout: 60000 }).toString();
      const streams = probe.split('\n').filter((l) => l.includes('Stream #')).map((l) => l.trim().replace(/\s+\[.*/, ''));
      console.log(`  built ${name}  (${(fs.statSync(f).size / 1024).toFixed(0)} KB)`);
      for (const s of streams) console.log('        ' + s.replace(/Stream #0:\d+(\([^)]*\))?: /, ''));
    } catch (e) {
      console.log(`  BUILD FAILED ${name}: ${String(e.stderr || e.message).split('\n').slice(-2).join(' ').slice(0, 160)}`);
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

  const prof = path.join(os.tmpdir(), `movira-5ch-${process.pid}`);
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
        const mimes = ['video/mp4; codecs="avc1.640029, mp4a.40.2"', 'video/mp4; codecs="avc1.640029, opus"', 'video/mp4; codecs="avc1.640029"'];
        const out = [];
        for (const mime of mimes) {
          if (!MediaSource.isTypeSupported(mime)) { out.push({ mime: mime.slice(10, 52), skip: 'unsupported' }); continue; }
          const ms = new MediaSource();
          const v = document.createElement('video');
          v.src = URL.createObjectURL(ms);
          try {
            await new Promise((r, j) => { ms.addEventListener('sourceopen', r, { once: true }); setTimeout(() => j(new Error('sourceopen timeout')), 6000); });
            const sb = ms.addSourceBuffer(mime);
            const verdict = await new Promise((r) => {
              sb.addEventListener('error', () => r('REJECTED'), { once: true });
              try { sb.appendBuffer(buf); } catch (e) { return r('threw ' + e.message); }
              sb.addEventListener('updateend', () => r('appended, buffered to ' + (sb.buffered.length ? sb.buffered.end(0).toFixed(2) : '?') + 's'), { once: true });
              setTimeout(() => r('timeout'), 6000);
            });
            out.push({ mime: mime.slice(10, 52), verdict });
          } catch (e) { out.push({ mime: mime.slice(10, 52), verdict: e.message }); }
        }
        return JSON.stringify(out);
      })()`).catch((e) => JSON.stringify([{ verdict: 'ERR ' + e.message }]));
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