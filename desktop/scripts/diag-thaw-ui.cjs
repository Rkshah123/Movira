/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Two properties of the seek-thaw feature that the API-level test cannot see:
 *
 * 1. UI REACHABILITY. test-seek-thaw.cjs reads lagRecorder.lastSeek() over the
 *    debug bridge. That proves the measurement exists, NOT that a user can see
 *    it — the rows could be unrendered and the suite would still be green. This
 *    opens the Diagnostics panel the way a user does and asserts the thaw row is
 *    actually on screen with a real number in it.
 *
 * 2. CHAIN STABILITY. requestVideoFrameCallback re-arms itself once per frame,
 *    and a 200 ms watchdog re-arms it when it goes stale. If those two ever
 *    compound, chains multiply and the recorder silently becomes a main-thread
 *    load. The count is sampled before and after a burst of seeks and must not
 *    grow.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Movira.exe');
const MEDIA = path.join(ROOT, 'testmedia');
const CDP_PORT = 9950 + (process.pid % 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = () => path.join(os.tmpdir(), `movira-thawui-${process.pid}`);

let passed = 0; let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

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

/** Count live rVFC callbacks by watching registration vs invocation. */
const COUNT_HOOK = `(() => {
  const v = document.querySelector('video');
  if (!v || typeof v.requestVideoFrameCallback !== 'function') return 'unsupported';
  window.__c = { registered: 0, fired: 0 };
  const orig = v.requestVideoFrameCallback.bind(v);
  v.requestVideoFrameCallback = function (cb) {
    window.__c.registered++;
    return orig((now, meta) => { window.__c.fired++; return cb(now, meta); });
  };
  return 'ok';
})()`;

async function clickTrack(cdp, frac) {
  const b = await evJson(cdp, `JSON.stringify((() => { const el = document.querySelector('.timeline'); const r = el.getBoundingClientRect();
    return { left: r.left, width: r.width, y: Math.round(r.top + r.height / 2) }; })())`);
  const x = Math.round(b.left + b.width * frac);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: b.y }, 30000);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: b.y, button: 'left', clickCount: 1, buttons: 1 }, 30000);
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 1, y: b.y, button: 'left', buttons: 1 }, 30000).catch(() => {});
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 1, y: b.y, button: 'left', clickCount: 1, buttons: 0 }, 30000);
}

async function main() {
  const arg = process.argv[2];
  const file = arg ? (path.isAbsolute(arg) ? arg : path.join(MEDIA, arg)) : path.join(MEDIA, 'movie-2.86gb.mkv');
  console.log('Packaged exe:', EXE, fs.existsSync(EXE) ? '(found)' : '(MISSING)');
  console.log('Media:', file);
  if (!fs.existsSync(file)) throw new Error('not found: ' + file);

  const child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT, env: { ...process.env, MOVIRA_USER_DATA_DIR: profileDir() },
    stdio: 'ignore', windowsHide: true,
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
    if (!page) throw new Error('packaged app page not found');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) { await sleep(500); ready = await ev(cdp, `!!(window.__moviraTestPlay && window.__moviraServices)`).catch(() => false); }
    if (!ready) throw new Error('renderer never became ready');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await cdp.send('Page.bringToFront', {}).catch(() => {});

    await ev(cdp, `(() => { window.__moviraTestPlay([{ id: 'u', type: 'video', title: 'ui', path: ${JSON.stringify(file)} }], 0); return 1; })()`);
    let open = false;
    for (let i = 0; i < 400 && !open; i++) {
      await sleep(250);
      open = await ev(cdp, `(() => { const v=document.querySelector('video'); return !!(v && v.readyState >= 3 && !v.paused); })()`).catch(() => false);
    }
    ok('media plays', open);
    if (!open) throw new Error('never played');
    await sleep(2500);

    // ---- 1. UI REACHABILITY -------------------------------------------------
    console.log('\n== Diagnostics panel renders the thaw rows ==');
    // Open the panel the way a user does: click the real button.
    const btn = await evJson(cdp, `JSON.stringify((() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => /diagnostics/i.test(x.textContent || ''));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })())`);
    ok('a Diagnostics button is reachable on the home screen', !!btn, btn ? `at ${btn.x},${btn.y}` : 'no button found');
    if (btn) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y }, 30000);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: 1 }, 30000);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: 0 }, 30000);
      await sleep(700);
    }
    const panel = await evJson(cdp, `JSON.stringify((() => {
      const h = Array.from(document.querySelectorAll('h2')).find((x) => (x.textContent || '').trim() === 'Diagnostics');
      if (!h) return { open: false };
      const grid = document.querySelector('.diag-grid');
      const rows = Array.from(grid ? grid.querySelectorAll('div') : []).map((d) => {
        const s = d.querySelector('span'); const b = d.querySelector('b');
        return { label: (s ? s.textContent : '').trim(), value: (b ? b.textContent : '').trim() };
      });
      return { open: true, rows };
    })())`);
    ok('Diagnostics panel opens', panel.open === true);
    const row = (panel.rows || []).find((r) => /picture resumed/i.test(r.label));
    ok('the panel shows a "picture resumed" row', !!row, row ? `label="${row.label}" value="${row.value}"` : `rows: ${(panel.rows || []).map((r) => r.label).join(' | ')}`);

    // The panel polls at 2 Hz; give the seek a moment to register before reading.
    await sleep(400);
    await clickTrack(cdp, 0.55);
    let shown = null;
    for (let i = 0; i < 24; i++) {
      await sleep(400);
      shown = await evJson(cdp, `JSON.stringify((() => {
        const grid = document.querySelector('.diag-grid');
        if (!grid) return null;
        const d = Array.from(grid.querySelectorAll('div')).find((x) => /picture resumed/i.test((x.querySelector('span') || {}).textContent || ''));
        if (!d) return null;
        const b = d.querySelector('b');
        return (b ? b.textContent : '').trim();
      })())`);
      if (shown && /ms$/.test(shown)) break;
    }
    ok('after a click the panel shows a real millisecond value', !!shown && /\d+ ms$/.test(shown), `value="${shown}"`);

    // ---- 2. CHAIN STABILITY -------------------------------------------------
    console.log('\n== frame-callback chain stays bounded across repeated seeks ==');
    const installed = await ev(cdp, COUNT_HOOK);
    if (installed !== 'ok') {
      console.log('  ....  requestVideoFrameCallback not wrappable; skipping chain check');
    } else {
      await sleep(1500);
      const c1 = await evJson(cdp, `JSON.stringify(window.__c)`);
      for (const f of [0.25, 0.7, 0.15, 0.85, 0.35]) { await clickTrack(cdp, f); await sleep(1200); }
      const c2 = await evJson(cdp, `JSON.stringify(window.__c)`);
      // One live chain re-arms once per frame, so registrations track frames
      // ~1:1. Multiplication would show as registrations running away from
      // callbacks by a large factor.
      const ratio1 = c1.fired ? c1.registered / c1.fired : 0;
      const ratio2 = c2.fired ? c2.registered / c2.fired : 0;
      console.log(`  ....  before: registered=${c1.registered} fired=${c1.fired} (ratio ${ratio1.toFixed(2)})`);
      console.log(`  ....  after 5 seeks: registered=${c2.registered} fired=${c2.fired} (ratio ${ratio2.toFixed(2)})`);
      ok('one registration per presented frame (chain not multiplying)', ratio2 < 1.35, `ratio ${ratio2.toFixed(2)} (1.00 = one chain)`);
      ok('the recorder kept working across the seeks', c2.fired > c1.fired, `fired ${c1.fired} -> ${c2.fired}`);
    }
    ok('no renderer exceptions', cdp.errs.length === 0, cdp.errs.slice(0, 3).join(' | '));
  } finally {
    try { child.kill(); } catch { /* ignore */ }
  }
  console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FAILED:', e.stack); process.exit(2); });