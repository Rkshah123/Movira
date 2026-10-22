/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Bisect WHY heavy-dvd.mkv's first appendBuffer fails.
 *
 * Known: the plan is right (transcode-video), the codec string is supported
 * (isTypeSupported true, canPlayType "probably"), ffmpeg emits an ordinary
 * H.264 High + AAC-LC fragmented MP4, and that stream fires a SourceBuffer
 * error on its very first appendBuffer while the same pipeline on an H.264/AAC
 * MKV appends cleanly.
 *
 * This generates variants of the same transcode (stereo vs 5.1, 44.1k vs 48k,
 * video-only, different profiles) and appends each one in the real renderer, so
 * the rejected element is identified by experiment instead of by guessing.
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
const CDP_PORT = 9420 + (process.pid % 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SRC = path.join(MEDIA, 'heavy-dvd.mkv');

const OUT = ['-copyts', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4'];
const V = ['-map', '0:v:0?', '-sn', '-dn', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p'];
const VARIANTS = [
  // The ONLY difference between row 1 and row 2 is the channel count.
  ['A 5.1 AAC (source 5.1)', ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k']],
  ['B stereo AAC (-ac 2)', ['-map', '0:a:0?', '-ac', '2', '-c:a', 'aac', '-b:a', '192k']],
  ['C 5.1 AAC 48k', ['-map', '0:a:0?', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k']],
  ['D 5.1 AAC aac_low', ['-map', '0:a:0?', '-profile:a', 'aac_low', '-c:a', 'aac', '-b:a', '192k']],
  ['E video only (no audio at all)', ['-an']],
  ['F 5.1 -> AC3 copy (no transcode)', ['-map', '0:a:0?', '-c:a', 'copy', '-bsf:a', 'ac3']],
];

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-bisect-'));
  const files = [];
  for (const [i, [name, tail]] of VARIANTS.entries()) {
    // The "real app args" variant must use the app's own encoder settings.
    const real = name.startsWith('superfast');
    const v = real
      ? [...V.slice(0, 2), 'mpeg2video'].slice(0, 0).concat(['-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn',
        '-c:v', 'libx264', '-preset', 'superfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '60',
        '-force_key_frames', 'expr:gte(t,n_forced*2)', '-c:a', 'aac', '-b:a', '192k'])
      : [...V, ...tail];
    const f = path.join(dir, `v${i}.mp4`);
    try {
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', SRC, ...v, ...OUT, '-t', '4', f], { timeout: 240000 });
      files.push([name, f, fs.statSync(f).size]);
      console.log(`  built ${name} (${(fs.statSync(f).size / 1024).toFixed(0)} KB)`);
    } catch (e) { console.log(`  BUILD FAILED ${name}: ${String(e.message).slice(0, 120)}`); }
  }

  // Serve the variants over localhost so the page can fetch real bytes.
  const srv = http.createServer((req, res) => {
    const f = path.join(dir, path.basename(req.url));
    if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const prof = path.join(os.tmpdir(), `movira-bis-${process.pid}`);
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

    for (const [name, f, size] of files) {
      const out = await ev(cdp, `(async () => {
        const url = 'http://127.0.0.1:${port}/${path.basename(f)}';
        const res = await fetch(url);
        const buf = new Uint8Array(await res.arrayBuffer());
        const mimes = [
          'video/mp4; codecs="avc1.640029, mp4a.40.2"',
          'video/mp4; codecs="avc1.640029"',
          'video/mp4; codecs="mp4a.40.2"',
          'audio/mp4; codecs="mp4a.40.2"',
          'audio/mp4; codecs="ac-3"',
        ];
        const results = [];
        for (const mime of mimes) {
          if (!MediaSource.isTypeSupported(mime)) { results.push({ mime, skip: 'unsupported' }); continue; }
          const ms = new MediaSource();
          const v = document.createElement('video');
          v.src = URL.createObjectURL(ms);
          try {
            await new Promise((r, j) => { ms.addEventListener('sourceopen', r, { once: true }); setTimeout(() => j(new Error('sourceopen timeout')), 6000); });
            const sb = ms.addSourceBuffer(mime);
            const verdict = await new Promise((r) => {
              sb.addEventListener('error', () => r({ ok: 0, why: 'SourceBuffer error event' }), { once: true });
              try { sb.appendBuffer(buf); } catch (e) { return r({ ok: 0, why: 'threw: ' + e.message }); }
              sb.addEventListener('updateend', () => r({ ok: 1, end: sb.buffered.length ? +sb.buffered.end(0).toFixed(2) : -1 }), { once: true });
              setTimeout(() => r({ ok: 0, why: 'updateend timeout' }), 6000);
            });
            results.push({ mime: mime.slice(0, 46), ...verdict });
          } catch (e) { results.push({ mime: mime.slice(0, 46), ok: 0, why: e.message }); }
        }
        return JSON.stringify({ name: ${JSON.stringify(name)}, bytes: buf.length, results });
      })()`).catch((e) => JSON.stringify({ name, error: e.message }));
      console.log('\n  ' + out);
    }
  } finally {
    srv.close();
    try { child.kill(); } catch { /* ignore */ }
    await sleep(800);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(0);
})().catch((e) => { console.error('DIAG FAILED:', e.stack); process.exit(1); });