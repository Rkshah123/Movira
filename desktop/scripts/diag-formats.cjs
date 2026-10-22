/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * FORMAT SUPPORT VERIFICATION — measures, never assumes.
 *
 * "Movira supports .ts" is not a fact you can check by looking at an extension
 * table: what decides it is whether Chromium can demux AND decode the file, and
 * if not whether the ffmpeg -> fragmented-MP4 -> MSE escalation recovers it.
 * So every file is actually opened in the PACKAGED app and judged on evidence:
 *
 *   opens        : the source was accepted and the element got a duration
 *   plays        : readyState >= 3 and the element is not paused
 *   ADVANCES     : the file clock moves on its own. This is the one that
 *                  matters — a "playing" element stuck at position 0 with a
 *                  frozen picture is the classic false pass.
 *   tier         : native (Chromium decodes it) or ffmpeg->MSE (the escalation
 *                  rebuilt it), plus how long that took
 *
 * A file whose codec Chromium cannot decode ALWAYS reports MEDIA_ERR first —
 * that is the native tier failing and the engine escalating, not a dead file.
 * Only an error that PERSISTS across the escalation window is a failure.
 *
 * Usage:
 *   node scripts/diag-formats.cjs                 # bundled test media
 *   node scripts/diag-formats.cjs <abs path> ...  # the user's own files
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Movira.exe');
const MEDIA = path.join(ROOT, 'testmedia');
const CDP_PORT = 9700 + (process.pid % 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = () => path.join(os.tmpdir(), `movira-formats-${process.pid}`);

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
async function ev(cdp, e) {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('renderer: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const evJson = async (cdp, e) => JSON.parse(await ev(cdp, e));
const hhmmss = (s) => {
  if (!isFinite(s) || s < 0) return '??:??';
  const t = Math.round(s);
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};

const SNAP = `(() => {
  const v = document.querySelector('video');
  const e = window.__moviraServices.engine;
  const d = window.__moviraMseDebug;
  return JSON.stringify({
    ft: v ? +e.currentFileTime().toFixed(2) : -1,
    known: +(e.knownDuration() || 0).toFixed(2),
    elDur: v && isFinite(v.duration) ? +v.duration.toFixed(2) : -1,
    rs: v ? v.readyState : -1,
    paused: v ? v.paused : null,
    err: v && v.error ? v.error.code : null,
    tier2: e.isFallbackBusy() ? 1 : (v && v.currentSrc && v.currentSrc.startsWith('blob:')) ? 1 : 0,
    bytes: d ? d.byteCount : -1,
    ranges: v ? v.buffered.length : -1,
  });
})()`;

/**
 * Open ONE file and judge it on evidence. The advance check is the important
 * one: sample the file clock twice, 1.2 s apart, and require real movement.
 */
async function verify(cdp, file, label) {
  const t0 = Date.now();
  await ev(cdp, `(() => { window.__moviraTestPlay([{ id: 'f', type: 'video', title: ${JSON.stringify(label)}, path: ${JSON.stringify(file)} }], 0); return 1; })()`);
  let firstErrAt = 0;
  let playing = false;
  for (let i = 0; i < 320; i++) {
    await sleep(250);
    const s = await evJson(cdp, SNAP).catch(() => ({ rs: -1 }));
    if (s.rs >= 3 && s.paused === false) { playing = true; break; }
    if (s.err) {
      if (!firstErrAt) firstErrAt = Date.now();
      // The native tier failing and the engine escalating is EXPECTED for
      // containers/codecs Chromium cannot handle. Only give up once the
      // fallback has had a fair chance.
      else if (Date.now() - firstErrAt > 20000) break;
    }
  }
  const openMs = Date.now() - t0;
  const a = await evJson(cdp, SNAP).catch(() => ({}));
  await sleep(1200);
  const b = await evJson(cdp, SNAP).catch(() => ({}));
  const advanced = isFinite(a.ft) && isFinite(b.ft) ? b.ft - a.ft : 0;
  const res = {
    label, playing, advanced,
    ft: b.ft, known: b.known, elDur: b.elDur,
    err: b.err === undefined ? null : b.err,
    tier2: b.tier2 === 1, bytes: b.bytes, ranges: b.ranges,
    openMs,
    ok: playing && advanced > 0.15 && !b.err,
  };
  const tier = res.tier2 ? 'ffmpeg->MSE' : 'native';
  console.log(
    `${res.ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} ${tier.padEnd(12)} ` +
    `open ${String(openMs).padStart(6)}ms  dur ${hhmmss(res.known).padStart(8)}  ` +
    `rs=${res.ranges === undefined ? '?' : b.rs}  advanced ${advanced.toFixed(2)}s  ` +
    `pos ${hhmmss(res.ft)}` + (res.err ? `  ERROR code ${res.err}` : ''),
  );
  return res;
}

async function main() {
  console.log('Packaged exe:', EXE, fs.existsSync(EXE) ? '(found)' : '(MISSING)');
  const args = process.argv.slice(2).filter(Boolean);
  let files;
  if (args.length) {
    files = args.map((f) => ({ file: path.isAbsolute(f) ? f : path.resolve(process.cwd(), f), label: path.basename(f) }));
  } else {
    const bundled = ['clip.mp4', 'clip.m4v', 'clip.mov', 'clip.3gp', 'clip.avi', 'clip.flv', 'clip.wmv', 'clip.webm', 'clip.ts', 'clip-hevc.mp4', 'noaudio.mp4'];
    files = bundled.filter((f) => fs.existsSync(path.join(MEDIA, f))).map((f) => ({ file: path.join(MEDIA, f), label: f }));
  }
  for (const f of files) if (!fs.existsSync(f.file)) throw new Error('not found: ' + f.file);
  console.log(`Verifying ${files.length} file(s):\n`);

  const child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT, env: { ...process.env, MOVIRA_USER_DATA_DIR: profileDir() },
    stdio: 'ignore', windowsHide: true,
  });
  const results = [];
  try {
    let page = null;
    for (let i = 0; i < 90 && !page; i++) {
      await sleep(1000);
      try {
        const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        page = list.find((t) => t.type === 'page' && /dist[\\/]renderer[\\/]index\.html/.test(t.url));
      } catch { /* retry */ }
    }
    if (!page) throw new Error('packaged app page not found');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) { await sleep(500); ready = await ev(cdp, `!!(window.__moviraTestPlay && window.__moviraServices)`).catch(() => false); }
    if (!ready) throw new Error('renderer never became ready');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await cdp.send('Page.bringToFront', {}).catch(() => {});

    for (const f of files) results.push(await verify(cdp, f.file, f.label));
    if (cdp.errs.length) console.log('\nrenderer exceptions:', cdp.errs.slice(0, 5));
  } finally {
    try { child.kill(); } catch { /* ignore */ }
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} formats play correctly`);
  if (bad.length) console.log('NOT PLAYABLE: ' + bad.map((r) => r.label).join(', '));
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error('DIAG FAILED:', e.stack); process.exit(2); });