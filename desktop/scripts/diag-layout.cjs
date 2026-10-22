/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Diagnostic: layout audit — is anything pushed outside the window, clipped
 * without a scrollbar, or covered by an overlay (i.e. unclickable)?
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ffmpeg = require('ffmpeg-static');
const electron = require('electron');
const CDP_PORT = 9355;
let cdp;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-layout-'));
function gen(file, args) {
  const out = path.join(tmp, file);
  const argv = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const a of args) { if (typeof a === 'string' && a.startsWith('-i')) argv.push('-f', 'lavfi'); argv.push(a); }
  execFileSync(ffmpeg, [...argv, out], { timeout: 120000 });
  return out;
}
function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => { this.pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); setTimeout(() => rej(new Error('timeout ' + method)), 60000); }); }
}
async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Renderer exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

const AUDIT = `(() => {
  const vh = innerHeight, vw = innerWidth;
  const rep = (name, el) => {
    if (!el) return { name, missing: true };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const out = {
      name,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      inView: r.top >= -1 && r.left >= -1 && r.bottom <= vh + 1 && r.right <= vw + 1 && r.width > 0 && r.height > 0,
      overflowY: el.scrollHeight > el.clientHeight + 1,
      clipped: el.scrollHeight > el.clientHeight + 1 && !['auto', 'scroll'].includes(cs.overflowY),
      scrollable: ['auto', 'scroll'].includes(cs.overflowY),
      minH: cs.minHeight, h: cs.height, pos: cs.position,
    };
    // clickability of every visible button/input/select inside
    const bad = [];
    el.querySelectorAll('button, input, select, [role=button]').forEach((b) => {
      const br = b.getBoundingClientRect();
      if (br.width === 0 || br.height === 0) return;
      if (br.top < 0 || br.bottom > vh || br.left < 0 || br.right > vw) { bad.push('offscreen:' + (b.title || b.textContent || b.tagName).trim().slice(0, 18)); return; }
      const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
      if (!hit || !(hit.closest && hit.closest('button, input, select, [role=button]'))) {
        bad.push('covered:' + (b.title || b.textContent || b.tagName).trim().slice(0, 18) + '<-' + (hit ? hit.tagName + '.' + String(hit.className || '').slice(0, 20) : 'null'));
      }
    });
    out.badButtons = bad;
    out.buttonCount = el.querySelectorAll('button, input, select').length;
    return out;
  };
  const out = { viewport: [vw, vh], docScroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] };
  const cw = document.querySelector('.controls-row');
  if (cw) {
    const l = cw.querySelector('.left'), r = cw.querySelector('.right');
    out.widths = { row: Math.round(cw.scrollWidth), left: Math.round(l.scrollWidth), right: Math.round(r.scrollWidth),
      leftW: Math.round(l.getBoundingClientRect().width), rightW: Math.round(r.getBoundingClientRect().width),
      leftH: Math.round(l.getBoundingClientRect().height), rowH: Math.round(cw.getBoundingClientRect().height),
      rightH: Math.round(r.getBoundingClientRect().height),
      kids: Array.from(r.children).map((k) => k.tagName + '.' + String(k.className || '').slice(0, 12) + ':' + Math.round(k.getBoundingClientRect().width) + 'x' + Math.round(k.getBoundingClientRect().height) + '@' + Math.round(k.getBoundingClientRect().left)),
      lkids: Array.from(l.children).map((k) => k.tagName + '.' + String(k.className || '').slice(0, 12) + ':' + Math.round(k.getBoundingClientRect().width) + 'x' + Math.round(k.getBoundingClientRect().height) + '@' + Math.round(k.getBoundingClientRect().left)),
      rcs: (() => { const c = getComputedStyle(r); return { width: c.width, flex: c.flex, shrink: c.flexShrink, basis: c.flexBasis, minW: c.minWidth, wrap: c.flexWrap, scrollW: r.scrollWidth }; })(),
      rkids: Array.from(r.querySelectorAll('*')).map((k) => k.tagName + '.' + String(k.className || '').slice(0, 10) + ':' + Math.round(k.getBoundingClientRect().width) + '@' + Math.round(k.getBoundingClientRect().left) + ',' + Math.round(k.getBoundingClientRect().top)),
      volcs: (() => { const v = document.querySelector('.volume-slider'); if (!v) return 'none'; const c = getComputedStyle(v); const q = v.getBoundingClientRect(); return { width: c.width, flex: c.flex, basis: c.flexBasis, rect: [Math.round(q.width), Math.round(q.left)] }; })() };
  }
  out.transport = rep('transport', document.querySelector('.transport'));
  out.playerView = rep('player-view', document.querySelector('.player-view'));
  out.videoHost = rep('video-host', document.querySelector('.video-host'));
  out.topbar = rep('topbar', document.querySelector('.topbar'));
  out.floating = rep('floating-panel', document.querySelector('.floating-panel'));
  if (document.querySelector('.floating-panel')) {
    const inner = document.querySelector('.floating-panel').firstElementChild;
    out.floatingInner = rep('floating-inner', inner);
  }
  return JSON.stringify(out);
})()`;

const keyEscape = () => `(() => { const k = { key: 'Escape', bubbles: true, cancelable: true };
  document.body.dispatchEvent(new KeyboardEvent('keydown', k)); return 1; })()`;

async function main() {
  console.log('Generating media...');
  const V = ['testsrc=size=320x240:rate=25:duration=60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50'];
  const A = ['-c:a', 'aac', '-b:a', '96k'];
  const mp4 = gen('clip.mp4', ['-i', V[0], '-i', 'sine=frequency=440:duration=60,volume=0', V[1], V[2], V[3], V[4], ...A, '-f', 'mp4']);

  console.log('Launching Electron app...');
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, MOVIRA_USER_DATA_DIR: path.join(os.tmpdir(), 'movira-test-profile-diaglayout') },
    stdio: 'ignore', windowsHide: true,
  });
  const show = async (label) => {
    const raw = JSON.parse(await evalJs(cdp, AUDIT));
    console.log('\n### ' + label);
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'object' && v && v.name) console.log('  ', k, JSON.stringify(v));
      else console.log('  ', k, JSON.stringify(v));
    }
  };
  try {
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      await sleep(1000);
      try {
        const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        page = list.find((t) => t.type === 'page' && /dist[\\/]renderer[\\/]index\.html/.test(t.url));
      } catch { /* retry */ }
    }
    if (!page) throw new Error('app page not found');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    cdp = new Cdp(ws);
    await sleep(2500);

    await show('startup (home)');
    await evalJs(cdp, `(async () => { window.__moviraTestPlay([{ id: 'l', type: 'video', title: 'clip', path: ${JSON.stringify(mp4)} }], 0); return 1; })()`);
    await sleep(4000);
    await show('playing');
    const nav = async (i, label) => {
      await evalJs(cdp, `(() => { document.querySelectorAll('.topbar .btn.topbar-nav')[${i}].click(); return 1; })()`);
      await sleep(700);
      await show(label);
      await evalJs(cdp, `(() => { const stage = document.querySelector('.player-stage') || document.body; stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 1; })()`);
      await sleep(400);
    };
    // --- CSS experiment: what makes the right group honour the slider width ---
    const exp = await evalJs(cdp, `(() => {
      const r = document.querySelector('.controls-row .right');
      const z = document.querySelector('.volume-zone');
      const s = document.querySelector('.volume-slider');
      const row = document.querySelector('.controls-row');
      const m = (tag) => [tag, 'zone=' + Math.round(z.getBoundingClientRect().width), 'right=' + Math.round(r.getBoundingClientRect().width), 'rightScroll=' + r.scrollWidth, 'rowH=' + Math.round(row.getBoundingClientRect().height), 'sRight=' + Math.round(s.getBoundingClientRect().right), 'rRight=' + Math.round(r.getBoundingClientRect().right)].join(' ');
      const out = [m('baseline')];
      z.style.width = '130px'; out.push(m('zone width=130')); z.style.width = '';
      r.style.flexWrap = 'nowrap'; out.push(m('right nowrap')); r.style.flexWrap = '';
      z.style.flexShrink = '0'; out.push(m('zone shrink=0')); z.style.flexShrink = '';
      z.style.minWidth = 'max-content'; out.push(m('zone minW=max-content')); z.style.minWidth = '';
      s.style.flex = 'none'; s.style.width = '90px'; out.push(m('slider flex none')); s.style.flex = ''; s.style.width = '';
      z.style.display = 'contents'; out.push(m('zone display:contents')); z.style.display = '';
      r.style.flexWrap = 'nowrap'; z.style.flexShrink = '0'; out.push(m('both fixes')); r.style.flexWrap = ''; z.style.flexShrink = '';
      return JSON.stringify(out, null, 1);
    })()`);
    console.log('=== volume-zone experiment ==='); console.log(exp);

    // fullscreen
    await evalJs(cdp, `(() => { const b = Array.from(document.querySelectorAll('.transport button')).find((x) => /Fullscreen/.test(x.title)); b.click(); return 1; })()`);
    await sleep(1500);
    await show('FULLSCREEN');
    const fsDetail = await evalJs(cdp, `(() => {
      const t = document.querySelector('.transport');
      const st = document.querySelector('.player-stage');
      const v = document.querySelector('video');
      const r = t.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(innerHeight - 5, r.top + r.height / 2));
      return JSON.stringify({ vp: [innerWidth, innerHeight], transport: [r.left, r.top, r.width, r.height],
        transportPos: getComputedStyle(t).position, transportZ: getComputedStyle(t).zIndex,
        stagePos: getComputedStyle(st).position, stageZ: getComputedStyle(st).zIndex,
        stageRect: (() => { const q = st.getBoundingClientRect(); return [q.left, q.top, q.width, q.height]; })(),
        hitAtTransport: hit ? hit.tagName + '.' + String(hit.className || '').slice(0, 30) : 'null',
        paused: v.paused });
    })()`);
    console.log('  fullscreen detail:', fsDetail);
    await evalJs(cdp, keyEscape());
    await sleep(1200);
    await show('after Escape');

    await nav(1, 'library');
    await nav(2, 'playlists');
    await nav(4, 'settings');
  } finally { try { child.kill(); } catch { /* ignore */ } }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });