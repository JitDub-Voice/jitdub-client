// Генерирует src-tauri/icons/icon.png (256×256) и icon.ico из того же рисунка, что ui/icons/jd/logo.svg:
// скруглённый квадрат с градиентом и столбики «волны». Без внешних зависимостей: node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons');
fs.mkdirSync(OUT, { recursive: true });

function render(S) {
  const px = Buffer.alloc(S * S * 4);
  const k = S / 64;
  const bars = [[12, 26, 12], [21, 18, 28], [30, 12, 40], [39, 20, 24], [48, 27, 10]]; // x, y, h (в координатах 64)
  const inRound = (x, y, x0, y0, w, h, r) => {
    const cx = Math.min(Math.max(x, x0 + r), x0 + w - r), cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const SS = 4; // суперсэмплинг для сглаживания краёв
  for (let py = 0; py < S; py++) for (let pxl = 0; pxl < S; pxl++) {
    let a = 0, wsum = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = (pxl + (sx + 0.5) / SS) / k, y = (py + (sy + 0.5) / SS) / k;
      if (!inRound(x, y, 0, 0, 64, 64, 14)) continue;
      a++;
      if (bars.some(([bx, by, bh]) => inRound(x, y, bx, by, 5, bh, 2.5))) wsum++;
    }
    const cov = a / (SS * SS), white = a ? wsum / a : 0;
    const t = (pxl + py) / (2 * S);
    const r = 0x46 + (0x95 - 0x46) * t, g = 0x7f + (0x5a - 0x7f) * t, b = 0xf2 + (0xe0 - 0xf2) * t;
    const i = (py * S + pxl) * 4;
    px[i] = Math.round(r + (255 - r) * white);
    px[i + 1] = Math.round(g + (255 - g) * white);
    px[i + 2] = Math.round(b + (255 - b) * white);
    px[i + 3] = Math.round(cov * 255);
  }
  return px;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(S) {
  const px = render(S);
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(png);
fs.writeFileSync(path.join(OUT, 'icon.png'), pngs[pngs.length - 1]);

// ICO с PNG-кадрами
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
fs.writeFileSync(path.join(OUT, 'icon.ico'), Buffer.concat([head, ...dir, ...pngs]));
console.log('иконки записаны в', OUT);
