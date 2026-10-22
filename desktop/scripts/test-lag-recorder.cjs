/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verify the lag recorder end-to-end against the PACKAGED binary:
 * open a real file, play it, seek it, then pull the recorded evidence.
 *
 * This asserts the recorder is WIRED (attaches to the live element, samples,
 * produces a report) rather than asserting any particular stall occurs --
 * whether a stall happens is the machine's business, not the test's.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Movira.exe');
const PORT = 9700 + (process.pid % 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(os.tmpdir(), `movira-test-profile-lag-${process.pid}`);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

function httpJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error('packaged exe missing: ' + EXE);
  const target = process.argv[2];
  if (!target || !fs.existsSync(target)) throw new Error('usage: node test-lag-recorder.cjs <media-file>');

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    cwd: ROOT, env: { ...process.env, MOVIRA_USER_DATA_DIR: profile }, stdio: 'ignore', windowsHide: true,
  });
  try {
    let page = null;
    for (let i = 0; i < 90 && !page; i++) {
      await sleep(1000);
      try {
        const l = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
        page = l.find((t) => t.type === 'page' && /dist[\\/]renderer[\\/]index\.html/.test(t.url));
      } catch { /* retry */ }
    }
    if (!page) throw new Error('app page not found');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    });
    const send = (method, params) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('CDP timeout: ' + method)); } }, 20000);
    });
    const ev = async (e) => {
      const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      return r.result && r.result.value;
    };

    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) { await sleep(500); ready = await ev('!!(window.__moviraTestPlay && window.__moviraLagReport)').catch(() => false); }
    ok(ready, 'recorder hooks exposed on window');

    console.log('  opening: ' + path.basename(target));
    await ev(`(() => { window.__moviraTestPlay([{ id:'p', type:'video', title:'lagtest', path:${JSON.stringify(target)} }], 0); return 1; })()`);
    let playing = false;
    for (let i = 0; i < 160 && !playing; i++) {
      await sleep(250);
      playing = await ev('(() => { const v=document.querySelector("video"); return !!v && !v.paused && v.readyState>=2 ? 1 : 0; })()').catch(() => 0);
    }
    ok(!!playing, 'file is playing');

    // Play, then seek around, so the recorder sees real activity.
    for (let i = 0; i < 6; i++) {
      await ev(`(() => { const e=window.__moviraServices.engine; e.seek(${600 + i * 900}); return 1; })()`).catch(() => {});
      await sleep(1200);
    }
    await sleep(1500);

    const liveA = JSON.parse(await ev('JSON.stringify(window.__moviraLagLive())'));
    await sleep(4000);
    const liveB = JSON.parse(await ev('JSON.stringify(window.__moviraLagLive())'));
    const live = liveB;
    const rep = JSON.parse(await ev('JSON.stringify(window.__moviraLagReport())'));

    ok(live.recording === true, 'recorder attached and recording');
    // A one-shot count proves nothing about whether the loop is ALIVE: a
    // recorder that sampled once and died would still report a positive
    // number. Growth over time is the assertion that matters.
    ok(liveB.samples > liveA.samples, `sampling is live (${liveA.samples} -> ${liveB.samples} in 4s)`);
    ok(live.readyState >= 2, `element reports readyState=${live.readyState}`);
    ok(live.totalFrames > 0, `decode counters advancing (totalFrames=${live.totalFrames})`);
    ok(rep.version === 1, 'report has a version');
    ok(rep.sampleCount >= live.samples - 5, `report sample count matches (${rep.sampleCount})`);
    ok(typeof rep.worstGapMs === 'number' && rep.worstGapMs >= 0, `worst gap recorded (${rep.worstGapMs}ms)`);
    ok(rep.stallCount === (rep.incidents || []).length, `stall count matches incidents (${rep.stallCount})`);
    ok(rep.src.length > 0, 'report identifies the source file');
    ok(rep.durationSec > 0, `report knows duration (${rep.durationSec}s)`);

    // The Diagnostics view must be REACHABLE from the UI. A view that exists
    // but has no entry point is a dead feature, and no amount of unit-level
    // passing would catch that — so navigate there the way a user would.
    const found = await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /diagnostics/i.test(x.textContent || ''));
      if (!b) return 0;
      b.click();
      return 1;
    })()`).catch(() => 0);
    await sleep(1200);
    const viewOk = await ev('(() => (document.querySelector(".diag-grid") ? 1 : 0))()').catch(() => 0);
    const heading = await ev('(() => { const h = document.querySelector(".settings-view h2"); return h ? h.textContent : ""; })()').catch(() => '');
    ok(found === 1, 'Diagnostics button exists and is clickable');
    ok(viewOk === 1, 'Diagnostics view renders its live panel');
    ok(/diagnostic/i.test(String(heading)), `panel is titled "${heading}"`);
    if (rep.stallCount > 0) {
      const inc = rep.incidents[0];
      ok(Array.isArray(inc.pre) && inc.pre.length > 0, `incident keeps the run-up (${inc.pre.length} samples)`);
      ok(typeof inc.gapMs === 'number', `incident records the stall size (${inc.gapMs}ms, kind=${inc.kind})`);
    } else {
      console.log('  NOTE  no stall >400ms occurred in this run (nothing wrong; the machine was responsive)');
    }
    console.log(`\n  live: gap=${live.gapMs}ms worst=${live.worstGapMs}ms longtask=${live.worstLongTaskMs}ms dropped=${live.droppedFrames}/${live.totalFrames} heap=${live.heapMB}MB tier2=${live.tier2 ? 'yes' : 'no'}`);
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await sleep(1500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().then(() => {
  console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FAILED:', e.stack); process.exit(1); });