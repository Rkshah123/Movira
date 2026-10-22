/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Generate media that is REALISTIC in the two ways that matter for the
 * "2.86 GB MKV lags" report:
 *   1. SIZE  -> bigmovie.mkv is ~2.9 GB, like the user's file.
 *   2. SHAPE -> long duration (2.5 h) with real keyframe spacing, plus a
 *      tier-2 file (mpeg2video + ac3 + multi track) and one file per container.
 *
 * Encoding 2.5 h of 1080p from scratch takes an hour, so each long file is
 * built by encoding one master segment and then replicating it with
 * `-stream_loop -c copy`. That is lossless, fast, and produces a genuinely
 * multi-gigabyte file with a real 2.5 h timeline.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('ffmpeg-static');

const OUT = process.env.MOVIRA_BIGMEDIA || path.join(__dirname, '..', 'testmedia');
fs.mkdirSync(OUT, { recursive: true });

function run(args, label) {
  const t = Date.now();
  execFileSync(ffmpeg, args, { timeout: 60 * 60 * 1000, stdio: ['ignore', 'ignore', 'inherit'] });
  process.stdout.write(`  ok   ${label}  ${((Date.now() - t) / 1000).toFixed(0)}s\n`);
}
const B = ['-hide_banner', '-loglevel', 'error', '-y'];
const MUTED = (d) => `sine=frequency=440:duration=${d},volume=0`;

function grow(src, out, seconds) {
  const loops = Math.ceil(seconds / 45);
  run([...B, '-stream_loop', String(loops - 1), '-i', src, '-c', 'copy',
    '-t', String(seconds), '-fflags', '+genpts', out],
    `${path.basename(out)} (${loops}x copy)`);
}

const only = process.argv[2] || 'all';

// ---------------------------------------------------------------- big movie
// 2.5 h, 1080p24, H.264, ~2.9 GB, keyframe every 4 s like a real encode.
if (only === 'all' || only === 'big') {
  const seg = path.join(OUT, '_seg_big.mkv');
  run([...B,
    '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=24:d=45',
    '-f', 'lavfi', '-i', MUTED(45),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '4800k', '-maxrate', '4800k',
    '-bufsize', '9600k', '-g', '96', '-keyint_min', '96', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-f', 'matroska', seg], 'master segment (1080p H.264)');
  grow(seg, path.join(OUT, 'bigmovie.mkv'), 9000);
  fs.rmSync(seg, { force: true });
}

// ------------------------------------------------------------- tier-2 movie
// Chromium cannot decode mpeg2video/ac3 -> the ffmpeg->MSE tier-2 path.
if (only === 'all' || only === 'heavy') {
  const seg = path.join(OUT, '_seg_heavy.mkv');
  run([...B,
    '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=40',
    '-f', 'lavfi', '-i', MUTED(40),
    '-f', 'lavfi', '-i', MUTED(40),
    '-f', 'lavfi', '-i', MUTED(40),
    '-f', 'lavfi', '-i', MUTED(40),
    '-c:v', 'mpeg2video', '-b:v', '6000k', '-g', '50',
    '-c:a', 'ac3', '-b:a', '448k', '-ac', '6',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-map', '4:a',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English 5.1',
    '-metadata:s:a:1', 'language=fra', '-metadata:s:a:1', 'title=French',
    '-metadata:s:a:2', 'language=spa', '-metadata:s:a:2', 'title=Spanish',
    '-metadata:s:a:3', 'language=jpn', '-metadata:s:a:3', 'title=Japanese',
    '-f', 'matroska', seg], 'master segment (mpeg2video + 4x AC3 5.1)');
  grow(seg, path.join(OUT, 'heavy-dvd.mkv'), 1200);
  fs.rmSync(seg, { force: true });
}

// ------------------------------------------------------- container zoo (60 s)
if (only === 'all' || only === 'ext') {
  const S = 'color=c=0x203040:s=1280x720:r=25:d=60';
  const A = MUTED(60);
  const mk = (o) => path.join(OUT, o);
  run([...B, '-f', 'lavfi', '-i', S, '-f', 'lavfi', '-i', A, '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'mp3', '-b:a', '128k', '-f', 'avi', mk('clip.avi')], 'clip.avi (mpeg4/mp3)');
  run([...B, '-f', 'lavfi', '-i', S, '-f', 'lavfi', '-i', A, '-c:v', 'libxvid', '-b:v', '900k', '-c:a', 'libmp3lame', '-f', 'avi', mk('clip2.avi')], 'clip2.avi (xvid/mp3)');
  run([...B, '-f', 'lavfi', '-i', S, '-f', 'lavfi', '-i', A, '-c:v', 'wmv2', '-b:v', '900k', '-c:a', 'wmav2', '-f', 'asf', mk('clip.wmv')], 'clip.wmv (wmv2)');
  run([...B, '-f', 'lavfi', '-i', S, '-f', 'lavfi', '-i', A, '-c:v', 'flv', '-b:v', '900k', '-c:a', 'mp3', '-b:a', '128k', '-f', 'flv', mk('clip.flv')], 'clip.flv');
  run([...B, '-f', 'lavfi', '-i', S, '-f', 'lavfi', '-i', A, '-c:v', 'libvpx', '-b:v', '800k', '-g', '50', '-c:a', 'libvorbis', '-f', 'webm', mk('clip.webm')], 'clip.webm (VP8)');
  run([...B, '-f', 'lavfi', '-i', S, '-f', 'lavfi', '-i', A, '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '1500k', '-g', '50', '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', mk('clip.mov')], 'clip.mov');
  run([...B, '-f', 'lavfi', '-i', S, '-f', 'lavfi', '-i', A, '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '1500k', '-g', '50', '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', mk('clip.m4v')], 'clip.m4v');
  run([...B, '-f', 'lavfi', '-i', S, '-f', 'lavfi', '-i', A, '-c:v', 'mpeg2video', '-b:v', '4000k', '-g', '50', '-c:a', 'mp2', '-b:a', '192k', '-f', 'mpegts', mk('clip.ts')], 'clip.ts (mpeg2video)');
  run([...B, '-f', 'lavfi', '-i', S, '-f', 'lavfi', '-i', A, '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '900k', '-g', '50', '-c:a', 'aac', '-b:a', '64k', '-f', 'mp4', mk('clip.3gp')], 'clip.3gp');
  run([...B, '-f', 'lavfi', '-i', S, '-f', 'lavfi', '-i', A, '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '900k', '-g', '50', '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', mk('clip.mp4')], 'clip.mp4');
  run([...B, '-f', 'lavfi', '-i', S, '-f', 'lavfi', '-i', A, '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-b:v', '1200k', '-tag:v', 'hvc1', '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', mk('clip-hevc.mp4')], 'clip-hevc.mp4');
  run([...B, '-f', 'lavfi', '-i', 'color=c=0x334455:s=1280x720:r=25:d=60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '900k', '-g', '50', '-an',
    '-f', 'mp4', mk('noaudio.mp4')], 'noaudio.mp4 (video only)');
}

for (const f of fs.readdirSync(OUT).sort()) {
  const mb = (fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(1);
  console.log(`  ${f.padEnd(22)} ${mb.padStart(10)} MB`);
}
console.log('done');