const sharp = require(process.env.SHARP_DIR ? `${process.env.SHARP_DIR}/node_modules/sharp` : 'sharp');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'movira.png');

async function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function png(size, out) {
  await ensureDir(path.dirname(out));
  await sharp(src).resize(size, size, { fit: 'cover' }).png().toFile(out);
  console.log('png', size, out);
}

function png2ico(sizes, outPath) {
  const pngs = sizes.map((s) => fs.readFileSync(path.join(root, 'desktop/assets/icon', `${s}.png`)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const entries = [];
  let offset = 6 + sizes.length * 16;
  const datas = [];
  pngs.forEach((data, i) => {
    const size = sizes[i];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
    datas.push(data);
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([header, ...entries, ...datas]));
  console.log('ico', outPath);
}

async function main() {
  await ensureDir(path.join(root, 'desktop/assets/icon'));
  fs.copyFileSync(src, path.join(root, 'desktop/assets/movira.png'));

  for (const s of [16, 24, 32, 48, 64, 128, 256]) {
    await png(s, path.join(root, 'desktop/assets/icon', `${s}.png`));
  }
  png2ico([16, 24, 32, 48, 64, 128, 256], path.join(root, 'desktop/assets/icon.ico'));

  const androidSizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [dpi, size] of Object.entries(androidSizes)) {
    await png(size, path.join(root, 'mobile/android/app/src/main/res/mipmap-' + dpi, 'ic_launcher.png'));
    await png(size, path.join(root, 'mobile/android/app/src/main/res/mipmap-' + dpi, 'ic_launcher_round.png'));
  }
  await png(432, path.join(root, 'mobile/android/app/src/main/res/drawable', 'movira_logo.png'));
  await png(1024, path.join(root, 'mobile/android/app/src/main/res/drawable', 'movira_splash.png'));

  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
