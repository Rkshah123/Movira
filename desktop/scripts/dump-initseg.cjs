/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * 6-channel AAC is fine (upmixed stereo appends). 6-channel AAC produced from
 * AC3 5.1 does NOT. Same codec string, same channel count, different init
 * segment. So read the audio sample entry and the esds payload of both and
 * print the bytes that matter, rather than guessing.
 *
 * AudioSampleEntry layout after the box header (8 bytes):
 *   +0  reserved(6)  +6  data_reference_index(2)
 *   +8  reserved(8)  (version 2 + revision 2 + vendor 4)
 *   +16 channelcount(2)  +18 samplesize(2)  +20 pre_defined(2)  +22 reserved(2)
 *   +24 samplerate(4) 16.16 fixed point
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const MEDIA = path.join(ROOT, 'testmedia');
const ffmpeg = require('ffmpeg-static');
const OK = path.join(MEDIA, 'movie-2.86gb.mkv');
const DVD = path.join(MEDIA, 'heavy-dvd.mkv');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movira-init-'));
const OUT = ['-copyts', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4'];
const VID = ['-map', '0:v:0?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-g', '60'];

function build(name, src, tail) {
  const f = path.join(dir, name + '.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, ...VID, ...tail, ...OUT, '-t', '2', f], { timeout: 240000 });
  return f;
}

const cases = [
  ['ACCEPTED  stereo -> 5.1 upmix, AAC', build('accepted', OK, ['-map', '0:a:0?', '-af', 'pan=5.1|c0=c0|c1=c1|c2=c0|c3=c1|c4=c0|c5=c1', '-c:a', 'aac', '-b:a', '384k'])],
  ['REJECTED  AC3 5.1 -> AAC', build('rejected', DVD, ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k'])],
];

for (const [label, f] of cases) {
  const buf = fs.readFileSync(f);
  const mp4a = buf.indexOf(Buffer.from('mp4a'));
  const esds = buf.indexOf(Buffer.from('esds'));
  const avc1 = buf.indexOf(Buffer.from('avc1'));
  console.log(`\n=== ${label} ===`);
  console.log(`  file ${(buf.length / 1024).toFixed(0)} KB   avc1@${avc1}  mp4a@${mp4a}  esds@${esds}`);
  if (mp4a >= 0) {
    const b = mp4a; // offset of the 4-char type == start of AudioSampleEntry fields
    const chan = buf.readUInt16BE(b + 8);
    const bps = buf.readUInt16BE(b + 10);
    const pre = buf.readUInt16BE(b + 12);
    const res = buf.readUInt16BE(b + 14);
    const sr = buf.readUInt32BE(b + 16) / 65536;
    console.log(`  AudioSampleEntry: channelcount=${chan} samplesize=${bps} pre_defined=${pre} reserved=${res} samplerate=${sr}`);
    console.log(`  raw mp4a[0..28]: ${buf.subarray(b, b + 28).toString('hex')}`);
  }
  if (esds >= 0) {
    console.log(`  esds payload  : ${buf.subarray(esds + 4, esds + 4 + 40).toString('hex')}`);
  }
  // The AudioSpecificConfig is the last descriptor inside esds.
  if (esds >= 0) {
    const dcd = buf.indexOf(Buffer.from([0x04]), esds + 4);
    if (dcd > 0) {
      // 0x05 = DecoderSpecificInfo tag, then a 1-byte length here (short form).
      const tag5 = buf.indexOf(Buffer.from([0x05]), dcd);
      if (tag5 > 0) {
        const len = buf[tag5 + 1];
        const asc = buf.subarray(tag5 + 2, tag5 + 2 + len);
        if (asc.length >= 2) {
          const aot = asc[0] >> 3;
          const freqIdx = ((asc[0] & 0x07) << 1) | (asc[1] >> 7);
          const chanCfg = (asc[1] >> 3) & 0x0f;
          console.log(`  AudioSpecificConfig [${asc.toString('hex')}]: objectType=${aot} freqIndex=${freqIdx} channelConfig=${chanCfg}`);
        }
      }
    }
  }
}
fs.rmSync(dir, { recursive: true, force: true });