// Compare the renderer bundle inside the packaged app.asar against dist/.
// Answers one question only: is the shipped binary the code we just built?
const asar = require('@electron/asar');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ASAR = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

const entries = asar.listPackage(ASAR);
const asset = entries.find((f) => /assets[\\/]index-[A-Za-z0-9_-]+\.js$/.test(f));
const htmlEntry = entries.find((f) => /renderer[\\/]index\.html$/.test(f));

console.log('asar renderer html entry :', htmlEntry);
console.log('asar renderer js entry   :', asset);
if (!asset) process.exit(1);

// listPackage prefixes every entry with a separator; extractFile wants the
// path without it and with the archive's own separators.
const asarPath = asset.replace(/^[\\/]/, '').replace(/\//g, '\\');
const packed = asar.extractFile(ASAR, asarPath);
const onDisk = path.join(ROOT, asarPath.replace(/\\/g, '/'));

console.log('');
console.log('packaged bundle  :', packed.length, 'bytes  md5', md5(packed));
if (fs.existsSync(onDisk)) {
  const local = fs.readFileSync(onDisk);
  console.log('dist bundle      :', local.length, 'bytes  md5', md5(local));
  console.log('');
  console.log(packed.equals(local)
    ? 'RESULT: packaged bundle IS IDENTICAL to dist (binary is current)'
    : 'RESULT: *** PACKAGED BUNDLE IS STALE - binary does NOT contain current code ***');
} else {
  console.log('RESULT: dist counterpart missing at', onDisk);
}

// Does the shipped bundle actually contain the wheel handler?
const text = packed.toString('utf8');
const probes = {
  'wheel SCROLLABLE selector': 'queue-panel, .subtitle-panel',
  'wheel addEventListener': "addEventListener(\"wheel\"",
  'passive:false': 'passive:!1',
};
console.log('');
for (const [name, needle] of Object.entries(probes)) {
  console.log((text.includes(needle) ? '  present ' : '  MISSING ') + name);
}
