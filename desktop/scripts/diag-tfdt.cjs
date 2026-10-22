/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Diagnostic: which ffmpeg flag combination preserves the media timeline
 * (-copyts) through the fragmented-MP4 muxer after a mid-file input seek?
 *
 * For each variant: remux with seek, write fMP4 to a file, then decode it back
 * with showinfo and report the FIRST decoded video pts_time — exactly what an
 * MSE element would see as the start of the buffered timeline.
 *   ~53.65 (seek 54 - 0.35) → timestamps preserved (muxer honored -copyts)
 *   ~0                      → muxer normalized the timeline (the bug)
 */
const { execFileSync, spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SEEK = Number(process.argv[2] ?? '54');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-tfdt-'));
const src = path.join(tmpDir, 'in.ts');

console.log(`Generating 90s mpeg-ts test file...`);
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=90',
  '-f', 'lavfi', '-i', 'sine=frequency=550:duration=90,volume=0',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50',
  '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts', src], { timeout: 60000 });

const VARIANTS = {
  current: [],
  avoid_neg_disabled: ['-avoid_negative_ts', 'disabled'],
  ts_offset: ['-output_ts_offset', String(SEEK - 0.35)],
  both: ['-avoid_negative_ts', 'disabled', '-output_ts_offset', String(SEEK - 0.35)],
};

console.log(`seek=${SEEK} (input -ss ${Math.max(0, SEEK - 0.35)}) — expected preserved start ≈ ${Math.max(0, SEEK - 0.35)}s\n`);

for (const [name, extra] of Object.entries(VARIANTS)) {
  const out = path.join(tmpDir, `out-${name}.mp4`);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(Math.max(0, SEEK - 0.35)),
    '-i', src,
    '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-copyts',
    ...extra,
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', out,
  ];
  const r = spawnSync(ffmpeg, args, { timeout: 60000, encoding: 'utf8' });
  if (r.status !== 0) {
    console.log(`${name}: FFMPEG FAILED\n  ${(r.stderr || '').split('\n').slice(-3).join('\n  ')}`);
    continue;
  }
  // Decode back and grab the first video frame's pts_time.
  const d = spawnSync(ffmpeg, ['-hide_banner', '-i', out, '-an', '-f', 'null', '-vf', 'showinfo', '-'], {
    timeout: 60000, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  });
  const m = /pts_time:([0-9.+-]+)/.exec(d.stderr || '');
  const first = m ? Number(m[1]) : null;
  console.log(`${name}: first video pts_time = ${first === null ? '??' : first + 's'} ${first !== null && Math.abs(first - (SEEK - 0.35)) < 1 ? '  <-- PRESERVED' : first !== null && Math.abs(first) < 0.6 ? '  <-- NORMALIZED TO 0' : ''}`);
}

// Also verify the whole range decodes: last pts_time vs expected duration.
const lastCheck = spawnSync(ffmpeg, ['-hide_banner', '-i', path.join(tmpDir, 'out-both.mp4'), '-an', '-f', 'null', '-vf', 'showinfo', '-'], {
  timeout: 60000, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
});
const times = [...(lastCheck.stderr || '').matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]));
if (times.length) console.log(`\nboth-variant range: ${times[0]}s → ${times[times.length - 1]}s (${times.length} frames, file ends at ${(90 - SEEK + 0.35).toFixed(2)}s of media)`);
