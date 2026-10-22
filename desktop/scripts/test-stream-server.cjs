/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * E2E test for the Movira fallback streaming server (runs under plain node).
 * Generates real problem-format media with ffmpeg, then verifies:
 *   1. probeMedia parses codecs/duration correctly
 *   2. decideMode picks the expected tier (MSE/fMP4-aware, with audio+video caps)
 *   3. startStream + HTTP GET delivers valid FRAGMENTED MP4 for every mode
 *      ('ftyp' at stream start, 'moof' fragments, 'mdat' payloads — the boxes
 *      Chromium's MSE SourceBuffer requires)
 *   4. seek (offset start) delivers fMP4 bytes
 *   5. session cancellation + bad input handling
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ffmpeg = require('ffmpeg-static');
const srv = require('../dist/streamServer');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-e2e-'));
let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function gen(file, args) {
  const out = path.join(tmp, file);
  // -f lavfi must precede EACH lavfi input (it applies per-input).
  const argv = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const a of args) {
    if (typeof a === 'string' && a.startsWith('-i')) argv.push('-f', 'lavfi');
    argv.push(a);
  }
  execFileSync(ffmpeg, [...argv, out], { timeout: 30000 });
  return out;
}

/** Downloads up to maxBytes from the stream URL and returns a summary. */
function httpGet(url, maxBytes = 300000, ms = 20000) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let bytes = 0;
    const req = http.get(url, (res) => {
      res.on('data', (d) => {
        chunks.push(d);
        bytes += d.length;
        if (bytes >= maxBytes) {
          req.destroy();
          finish(res.statusCode, true);
        }
      });
      res.on('end', () => finish(res.statusCode, false));
      res.on('error', () => finish(res.statusCode, bytes > 0));
    });
    req.on('error', () => { /* destroyed mid-download is fine */ });
    let done = false;
    function finish(status, truncated) {
      if (done) return;
      done = true;
      const buf = Buffer.concat(chunks);
      resolve({
        status,
        bytes: buf.length,
        truncated,
        mime: res_ ? res_.headers['content-type'] : null,
        head: buf.subarray(0, 16),
        hasFtyp: buf.indexOf('ftyp') !== -1 && buf.indexOf('ftyp') < 64,
        moofCount: countBox(buf, 'moof'),
        mdatCount: countBox(buf, 'mdat'),
      });
    }
    let res_ = null;
    setTimeout(() => {
      req.destroy();
      finish(0, false);
    }, ms);
    // capture res for mime inspection
    req.on('response', (r) => { res_ = r; });
  });
}

/** Counts occurrences of a 4CC box marker (naive but fine for generated media). */
function countBox(buf, fourCC) {
  const needle = Buffer.from(fourCC, 'ascii');
  let count = 0;
  let idx = buf.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = buf.indexOf(needle, idx + 1);
  }
  return count;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('ffmpeg:', ffmpeg);
  ok('ffmpeg-static present', !!ffmpeg && fs.existsSync(ffmpeg));

  // ---- 1) Generate problem formats ----
  const ts = gen('test.ts', ['-i', 'testsrc=size=320x240:rate=15:duration=3', '-i', 'sine=frequency=440:duration=3,volume=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'mpegts']);
  const avi = gen('test.avi', ['-i', 'testsrc=size=320x240:rate=15:duration=3', '-i', 'sine=frequency=440:duration=3,volume=0', '-c:v', 'mpeg4', '-c:a', 'libmp3lame', '-f', 'avi']);
  const mpg = gen('test.mpg', ['-i', 'testsrc=size=320x240:rate=15:duration=3', '-i', 'sine=frequency=440:duration=3,volume=0', '-c:v', 'mpeg2video', '-b:v', '500k', '-c:a', 'ac3', '-f', 'vob']);
  const wmv = gen('test.wmv', ['-i', 'testsrc=size=320x240:rate=15:duration=3', '-i', 'sine=frequency=440:duration=3,volume=0', '-c:v', 'wmv2', '-c:a', 'wmav2', '-f', 'asf']);
  // The fixtures above all use `sine`, which is MONO. The 5.1 case is the one
  // that actually broke playback, so it needs a real surround file.
  const dvd51 = gen('test-5.1.mkv', [
    '-i', 'testsrc=size=320x240:rate=15:duration=3',
    '-i', 'sine=frequency=440:duration=3,volume=0',
    '-filter_complex', '[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[a]',
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'ac3', '-b:a', '448k', '-f', 'matroska',
  ]);
  const dvdStereo = gen('test-stereo.mkv', [
    '-i', 'testsrc=size=320x240:rate=15:duration=3',
    '-i', 'sine=frequency=440:duration=3,volume=0',
    '-filter_complex', '[1:a]pan=stereo|c0=c0|c1=c0[a]',
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'ac3', '-b:a', '192k', '-f', 'matroska',
  ]);
  console.log('\n== probeMedia ==');

  // ---- 2) Probing ----
  const pTs = await srv.probeMedia(ts);
  ok('TS probe: h264+aac', pTs?.videoCodec === 'h264' && pTs?.audioCodec === 'aac', JSON.stringify(pTs));
  ok('TS probe: duration ~3s', pTs?.durationSec !== null && Math.abs(pTs.durationSec - 3) < 1, String(pTs?.durationSec));

  const pAvi = await srv.probeMedia(avi);
  ok('AVI probe: mpeg4+mp3', pAvi?.videoCodec === 'mpeg4' && pAvi?.audioCodec === 'mp3', JSON.stringify(pAvi));

  const pMpg = await srv.probeMedia(mpg);
  ok('MPG/VOB probe: mpeg2video', pMpg?.videoCodec === 'mpeg2video', JSON.stringify(pMpg));

  const pWmv = await srv.probeMedia(wmv);
  ok('WMV probe: wmv2+wmav2', pWmv?.videoCodec === 'wmv2' && pWmv?.audioCodec === 'wmav2', JSON.stringify(pWmv));

  const pMissing = await srv.probeMedia(path.join(tmp, 'nope.ts'));
  ok('probe missing file → null', pMissing === null);

  // Channel counts decide whether ffmpeg is told `-ac N`, which is the only
  // thing that makes a 5.1 (AC3 5.1(side)) source produce an init segment
  // Chromium accepts — without it the file NEVER plays. Probe and buildArgs
  // are therefore a single contract, asserted together here.
  console.log('\n== audio channel probe -> -ac (5.1 files must be playable) ==');
  const p51 = await srv.probeMedia(dvd51);
  ok('5.1 source: probe reports 6 channels', p51?.audioStreams?.[0]?.channels === 6, JSON.stringify(p51?.audioStreams));
  const pSt = await srv.probeMedia(dvdStereo);
  ok('stereo source: probe reports 2 channels', pSt?.audioStreams?.[0]?.channels === 2, JSON.stringify(pSt?.audioStreams));
  ok('mono source: probe reports 1 channel', pTs?.audioStreams?.[0]?.channels === 1, JSON.stringify(pTs?.audioStreams));
  const acOf = (argv) => { const i = argv.indexOf('-ac'); return i === -1 ? null : argv[i + 1]; };
  for (const mode of ['remux-tc-audio', 'transcode-video', 'transcode-audio-only']) {
    ok(`${mode}: -ac 6 passed for a 5.1 track`, acOf(srv.buildArgs(dvd51, mode, 0, 'ac3', 0, 6)) === '6');
    ok(`${mode}: -ac omitted when the count is unknown`, acOf(srv.buildArgs(dvd51, mode, 0, 'ac3', 0, null)) === null);
  }
  ok('remux never re-encodes audio, so it never needs -ac', acOf(srv.buildArgs(dvd51, 'remux', 0, 'aac', 0, 6)) === null);
  ok('-ac is placed before the output flags', (() => {
    const argv = srv.buildArgs(dvd51, 'transcode-video', 0, 'ac3', 0, 6);
    return argv.indexOf('-ac') !== -1 && argv.indexOf('-ac') < argv.indexOf('-movflags');
  })());

  console.log('\n== decideMode (MSE/fMP4-aware) ==');
  const probeOf = (v, a) => ({ videoCodec: v, audioCodec: a, durationSec: 3, fps: 15, width: 320, height: 240 });
  const capsAll = { audio: () => true, video: () => true };
  ok('h264+aac (decodable) → remux', srv.decideMode(probeOf('h264', 'aac'), capsAll.audio, capsAll.video) === 'remux');
  ok('h264+ac3 (ac3 not MP4-safe) → remux-tc-audio', srv.decideMode(probeOf('h264', 'ac3'), () => false, capsAll.video) === 'remux-tc-audio');
  ok('h264 but renderer lacks h264 → transcode-video', srv.decideMode(probeOf('h264', 'aac'), capsAll.audio, () => false) === 'transcode-video');
  ok('mpeg2video → transcode-video', srv.decideMode(probeOf('mpeg2video', 'mp2'), capsAll.audio, capsAll.video) === 'transcode-video');
  ok('wmv2 → transcode-video', srv.decideMode(probeOf('wmv2', 'wmav2'), capsAll.audio, capsAll.video) === 'transcode-video');
  ok('no video → transcode-audio-only', srv.decideMode(probeOf(null, 'wma'), capsAll.audio, capsAll.video) === 'transcode-audio-only');

  console.log('\n== streaming (fragmented MP4 for MSE) ==');
  const modes = ['remux', 'remux-tc-audio', 'transcode-video', 'transcode-audio-only'];
  for (const mode of modes) {
    const r = await srv.startStream({ src: ts, mode, seek: 0 });
    ok(`${mode}: startStream ok`, r.ok && !!r.url, r.reason ?? '');
    if (r.ok && r.url) {
      const res = await httpGet(r.url, 400000, 20000);
      ok(`${mode}: HTTP 200 + video/mp4`, res.status === 200 && res.mime === 'video/mp4', `${res.bytes}B type=${res.mime}`);
      ok(`${mode}: fMP4 structure (ftyp + moof + mdat)`, res.hasFtyp && res.moofCount > 0 && res.mdatCount > 0, `ftyp=${res.hasFtyp} moof=${res.moofCount} mdat=${res.mdatCount}`);
    }
  }

  console.log('\n== seek (offset start) ==');
  // The app passes the probed audio codec so TS-ADTS AAC gets the aac_adtstoasc filter.
  const rs = await srv.startStream({ src: ts, mode: 'remux', seek: 1, audioCodec: 'aac' });
  ok('seek start ok', rs.ok && !!rs.url);
  if (rs.ok && rs.url) {
    const res = await httpGet(rs.url, 200000, 20000);
    ok('seek: delivers fMP4 bytes', res.status === 200 && res.hasFtyp && res.moofCount > 0, `${res.bytes}B moof=${res.moofCount}`);
  }

  console.log('\n== session cancellation ==');
  const r1 = await srv.startStream({ src: ts, mode: 'remux' });
  await sleep(700); // let ffmpeg spin up
  const r2 = await srv.startStream({ src: avi, mode: 'transcode-video' });
  ok('second start supersedes first', r1.ok && r2.ok);
  srv.stopAllStreams();
  await sleep(200);
  console.log('  PASS  stopAllStreams completed without error');
  passed++;

  console.log('\n== bad input handling ==');
  const bad = await srv.startStream({ src: path.join(tmp, 'missing.avi'), mode: 'remux' });
  ok('missing file → ok:false', !bad.ok, bad.reason);

  console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E crashed:', e);
  process.exit(1);
});
