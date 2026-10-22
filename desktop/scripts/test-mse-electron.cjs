/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * True end-to-end MSE test: launches the real Electron app (dist build) with a
 * CDP debugger, starts ffmpeg fallback streams for generated problem files, and
 * appends them into a MediaSource SourceBuffer INSIDE the app's renderer — then
 * checks the <video> element actually plays frames.
 *
 * Validates: probe → decideMode → startStream → fetch (CSP connect-src!) →
 * MSE append → playback, exactly as the engine does it.
 */
const { execFileSync, spawn } = require('child_process');
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


let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-mse-'));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/** Minimal CDP client over WebSocket (node >=22 global WebSocket). */
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
      this.pending.set(id, (msg) => {
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 90000);
    });
  }
}

async function evalInApp(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error('Renderer exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

function mseTestExpression(src, expectedVideoCodec) {
  const entries = {
    h264: 'avc1.640029', hevc: 'hvc1.1.6.L93.B0', vp9: 'vp09.00.10.08',
    vp8: 'vp8', av1: 'av01.0.04M.08', mpeg4: 'mp4v.20.8',
  };
  const vEntry = entries[expectedVideoCodec] || null;
  const mime = vEntry
    ? `video/mp4; codecs="${vEntry}, mp4a.40.2"`
    : 'audio/mp4; codecs="mp4a.40.2"';
  return `(async () => {
    const api = window.movira;
    if (!api) return JSON.stringify({ fatal: 'no movira api' });
    const src = ${JSON.stringify(src)};
    const mime = ${JSON.stringify(mime)};
    try {
      const probe = await api.probeMedia(src);
      if (!probe) return JSON.stringify({ fatal: 'probe failed' });
      const audioCaps = ['aac','mp3','opus','flac'].filter((c) => document.createElement('video').canPlayType('audio/mp4; codecs="' + c + '"') !== '');
      const videoEntries = [['h264','avc1.640029'],['hevc','hvc1.1.6.L93.B0'],['vp8','vp8'],['vp9','vp09.00.10.08'],['av1','av01.0.04M.08']];
      const videoCaps = videoEntries.filter(([, e]) => document.createElement('video').canPlayType('video/mp4; codecs="' + e + '"') !== '').map(([n]) => n);
      const mode = await api.decideMode({ videoCodec: probe.videoCodec, audioCodec: probe.audioCodec }, audioCaps, videoCaps);
      const r = await api.startStream({ src, mode, audioCodec: probe.audioCodec });
      if (!r.ok) return JSON.stringify({ fatal: 'startStream: ' + r.reason });
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true;
      document.body.appendChild(v);
      const ms = new MediaSource();
      v.src = URL.createObjectURL(ms);
      await new Promise((res) => ms.addEventListener('sourceopen', res, { once: true }));
      let sb;
      try { sb = ms.addSourceBuffer(mime); } catch (e) { return JSON.stringify({ fatal: 'addSourceBuffer: ' + e.message + ' mime=' + mime }); }
      sb.mode = 'sequence';
      const res = await fetch(r.url);
      if (!res.ok) return JSON.stringify({ fatal: 'fetch status ' + res.status });
      const reader = res.body.getReader();
      let appended = 0, first = true;
      for (let i = 0; i < 400; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        await new Promise((res2, rej2) => {
          sb.addEventListener('updateend', res2, { once: true });
          sb.addEventListener('error', () => rej2(new Error('append error')), { once: true });
          try { sb.appendBuffer(value); } catch (e) { rej2(e); }
        });
        appended += value.length;
        if (first && sb.buffered.length) { try { v.currentTime = sb.buffered.start(0) + 0.05; } catch {} first = false; }
        if (sb.buffered.length && sb.buffered.end(sb.buffered.length - 1) > 2.5) break;
        if (appended > 4000000) break;
      }
      if (!sb.buffered.length) {
        reader.cancel().catch(() => {});
        v.remove();
        return JSON.stringify({ fatal: 'nothing buffered — MSE rejected the stream', appended, mime, mode, probe });
      }
      try { await v.play(); } catch (e) { /* muted autoplay should be allowed */ }
      const t0 = v.currentTime;
      await new Promise((r2) => setTimeout(r2, 2500));
      const out = {
        appended,
        mode,
        mime,
        probe,
        readyState: v.readyState,
        paused: v.paused,
        time: v.currentTime,
        advanced: v.currentTime > t0 + 0.5,
        videoW: v.videoWidth,
        videoH: v.videoHeight,
        error: v.error ? v.error.message : null,
        buffered: [sb.buffered.start(0), sb.buffered.end(sb.buffered.length - 1)],
      };
      try { reader.cancel().catch(() => {}); } catch {}
      v.remove();
      return JSON.stringify(out);
    } catch (e) {
      return JSON.stringify({ fatal: e.message });
    }
  })()`;
}

async function main() {
  ok('ffmpeg-static present', !!ffmpeg && fs.existsSync(ffmpeg));

  // Problem files: a .ts (user's report) and a .wmv (transcode tier).
  const ts = gen('test.ts', ['-i', 'testsrc=size=320x240:rate=25:duration=6', '-i', 'sine=frequency=440:duration=6,volume=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts']);
  const wmv = gen('test.wmv', ['-i', 'testsrc=size=320x240:rate=15:duration=5', '-i', 'sine=frequency=330:duration=5,volume=0', '-c:v', 'wmv2', '-b:v', '400k', '-c:a', 'wmav2', '-f', 'asf']);

  console.log('Launching Electron app with CDP on port', CDP_PORT);
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: path.join(__dirname, '..'),      env: { ...process.env, MOVIRA_USER_DATA_DIR: profileDir() },

    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    // Wait for the CDP endpoint and the app page target.
    let targets = null;
    for (let i = 0; i < 60 && !targets; i++) {
      await sleep(1000);
      try {
        const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        const page = list.find((t) => t.type === 'page' && /dist[\\/]renderer[\\/]index\.html/.test(t.url));
        if (page) targets = list;
      } catch { /* not up yet */ }
    }
    ok('Electron app launched with renderer page', !!targets);
    if (!targets) throw new Error('app page not found');

    const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = list.find((t) => t.type === 'page' && /dist[\\/]renderer[\\/]index\.html/.test(t.url));
    const WebSocket = global.WebSocket;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const cdp = new Cdp(ws);

    // expectedVideoCodec = what the EMITTED stream will contain (transcode-video
    // always outputs H.264+AAC, regardless of the source codec).
    for (const [file, vCodec, label] of [[ts, 'h264', '.ts (h264+aac — remux tier)'], [wmv, 'h264', '.wmv (wmv2 — transcode tier)']]) {
      console.log(`\n== In-app MSE playback: ${label} ==`);
      const raw = await evalInApp(cdp, mseTestExpression(file, vCodec));
      let out;
      try { out = JSON.parse(raw); } catch { console.log(raw); throw new Error('bad renderer response'); }
      if (out.fatal) {
        ok(`${file && path.basename(file)}: MSE pipeline`, false, out.fatal + (out.mime ? ` mime=${out.mime}` : ''));
        continue;
      }
      ok(`${path.basename(file)}: data appended into SourceBuffer`, out.appended > 10000, `${out.appended}B mode=${out.mode}`);
      ok(`${path.basename(file)}: video frames decoding`, out.videoW > 0 && out.readyState >= 3, `${out.videoW}x${out.videoH} rs=${out.readyState}`);
      ok(`${path.basename(file)}: playback advancing`, out.advanced && !out.paused, `t=${out.time?.toFixed(2)}s buf=[${out.buffered?.map((x) => x.toFixed(1)).join(',')}]`);
      ok(`${path.basename(file)}: no media error`, !out.error, out.error ?? '');
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

main().catch((e) => {
  console.error('MSE E2E crashed:', e);
  process.exit(1);
});
