/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Why does the FIRST appendBuffer fail for heavy-dvd.mkv?
 *
 * The plan is right (transcode-video), ffmpeg emits a perfectly ordinary
 * H.264 High + AAC-LC fragmented MP4, and yet appendCount stays 0 with
 * "sourcebuffer append failed". This tests MediaSource codec support and a
 * real append of the actual stream bytes inside the packaged renderer, with
 * candidate codec strings, so the failing element is identified directly
 * instead of inferred.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Movira.exe');
const MEDIA = path.join(ROOT, 'testmedia');
const CDP_PORT = 9450 + (process.pid % 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const prof = path.join(os.tmpdir(), `movira-mime-${process.pid}`);
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
    for (let i = 0; i < 60; i++) { await sleep(500); if (await ev(cdp, `!!(window.__moviraTestPlay && window.__moviraServices)`).catch(() => false)) break; }

    console.log('== canPlayType / isTypeSupported in THIS renderer ==');
    console.log(await ev(cdp, `(() => {
      const mimes = [
        'video/mp4; codecs="avc1.640029, mp4a.40.2"',
        'video/mp4; codecs="avc1.640029"',
        'video/mp4; codecs="avc1.4d4029, mp4a.40.2"',
        'video/mp4; codecs="avc1.42E029, mp4a.40.2"',
        'video/mp4; codecs="avc1.640029, mp4a.40.2"',
        'audio/mp4; codecs="mp4a.40.2"',
        'video/mp4; codecs="mp4v.20.8"',
      ];
      const el = document.createElement('video');
      return JSON.stringify(mimes.map((m) => ({ mime: m, isTypeSupported: MediaSource.isTypeSupported(m), canPlayType: el.canPlayType(m) })), null, 1);
    })()`));

    console.log('\n== real append of the actual stream bytes ==');
    const mkvs = fs.readdirSync(MEDIA).filter((f) => f.endsWith('.mkv')).sort();
    for (const name of mkvs) {
      const src = path.join(MEDIA, name);
      const out = await ev(cdp, `(async () => {
        const file = ${JSON.stringify(src)};
        // Reproduce what the engine does: spawn the stream server, fetch the
        // real first megabyte, and append it to a fresh MediaSource.
        const st = await window.movira.startStream({ src: file, mode: 'transcode-video', seek: 0, audioCodec: 'ac3', audioTrack: 0 });
        if (!window.movira) return JSON.stringify({ file: ${JSON.stringify(name)}, note: 'preload api not exposed on window' });
        if (!st || !st.ok || !st.url) return JSON.stringify({ file: ${JSON.stringify(name)}, startStream: JSON.stringify(st) });
        const res = await fetch(st.url);
        if (!res.ok) return JSON.stringify({ file: ${JSON.stringify(name)}, fetch: 'http ' + res.status });
        const reader = res.body.getReader();
        const chunks = []; let bytes = 0;
        while (bytes < 700000) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); bytes += value.length;
        }
        try { reader.cancel(); } catch {}
        const buf = new Uint8Array(bytes); let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.length; }
        const mime = 'video/mp4; codecs="avc1.640029, mp4a.40.2"';
        const ms = new MediaSource();
        const v = document.createElement('video');
        v.src = URL.createObjectURL(ms);
        const r = { file: ${JSON.stringify(name)}, bytes };
        try {
          await new Promise((res2, rej2) => { ms.addEventListener('sourceopen', res2, { once: true }); setTimeout(() => rej2(new Error('sourceopen timeout')), 8000); });
          const sb = ms.addSourceBuffer(mime);
          r.added = true;
          const verdict = await new Promise((res2) => {
            const fail = (why) => res2({ ok: false, why });
            sb.addEventListener('error', () => fail('SourceBuffer error event'), { once: true });
            try { sb.appendBuffer(buf); } catch (e) { return fail('threw: ' + e.message); }
            sb.addEventListener('updateend', () => res2({ ok: true, ranges: sb.buffered.length, end: sb.buffered.length ? +sb.buffered.end(0).toFixed(2) : -1 }), { once: true });
            setTimeout(() => fail('updateend timeout'), 8000);
          });
          r.append = verdict;
        } catch (e) { r.error = e.message; }
        try { window.movira.stopStream(st.id); } catch {}
        return JSON.stringify(r);
      })()`).catch((e) => JSON.stringify({ error: e.message }));
      console.log(' ', out);
    }
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await sleep(1000);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(0);
})().catch((e) => { console.error('DIAG FAILED:', e.stack); process.exit(1); });