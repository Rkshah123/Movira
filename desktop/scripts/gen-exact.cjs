/* eslint-disable @typescript-eslint/no-var-requires */
/** Trim bigmovie.mkv to an exact ~2.86 GB / 80 min file, matching the report. */
const { execFileSync } = require('child_process');
const path = require('path');
const ffmpeg = require('ffmpeg-static');
const OUT = path.join(__dirname, '..', 'testmedia');
const src = path.join(OUT, 'bigmovie.mkv');
const dst = path.join(OUT, 'movie-2.86gb.mkv');
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src,
  '-c', 'copy', '-t', '4800', dst], { timeout: 600000, stdio: ['ignore', 'ignore', 'inherit'] });
console.log('  ok  movie-2.86gb.mkv', (require('fs').statSync(dst).size / 1073741824).toFixed(2), 'GB');