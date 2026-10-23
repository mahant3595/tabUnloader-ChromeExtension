/**
 * Generates icons/icon{16,32,48,128}.png without any image dependency.
 * Renders a flat design (blue rounded square + white tab + down arrow) at 8x
 * supersampling, then box-downsamples for antialiased edges.
 *
 * Run: node tools/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = 8; // supersample factor
const MASTER = 128;

/* ---------- tiny raster canvas ---------- */
function makeCanvas(size) {
  return { size, data: new Uint8Array(size * size * 4) }; // RGBA, premultiplied? no — straight alpha
}

function blendPixel(cv, x, y, [r, g, b, a = 255]) {
  if (x < 0 || y < 0 || x >= cv.size || y >= cv.size) return;
  const i = (y * cv.size + x) * 4;
  cv.data[i] = r;
  cv.data[i + 1] = g;
  cv.data[i + 2] = b;
  cv.data[i + 3] = a;
}

const inRoundedRect = (px, py, x, y, w, h, r) => {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};

const inTriangle = (px, py, ax, ay, bx, by, cx, cy) => {
  const sign = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
};

function downsample(src, target) {
  const cv = makeCanvas(target);
  const ratio = src.size / target;
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const y0 = Math.floor(y * ratio), y1 = Math.floor((y + 1) * ratio);
      const x0 = Math.floor(x * ratio), x1 = Math.floor((x + 1) * ratio);
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.size + sx) * 4;
          const pa = src.data[i + 3];
          r += src.data[i] * pa;
          g += src.data[i + 1] * pa;
          b += src.data[i + 2] * pa;
          a += pa;
          n++;
        }
      }
      const o = (y * target + x) * 4;
      if (a > 0) {
        cv.data[o] = Math.round(r / a);
        cv.data[o + 1] = Math.round(g / a);
        cv.data[o + 2] = Math.round(b / a);
        cv.data[o + 3] = Math.round(a / n);
      }
    }
  }
  return cv;
}

/* ---------- design (all coordinates in 0..128 space) ---------- */
const BLUE = [37, 99, 235];   // #2563eb
const WHITE = [255, 255, 255];

function paintMaster(px, py) {
  // px, py are coordinates in 0..128 design units (subpixel centers included).
  // background rounded square (slightly inset so icon edges stay clean)
  if (inRoundedRect(px, py, 2, 2, 124, 124, 30)) {
    // white tab body
    if (inRoundedRect(px, py, 24, 44, 80, 60, 12)) return WHITE;
    // white tab bump
    if (inRoundedRect(px, py, 24, 26, 42, 26, 10)) return WHITE;
    // blue unload arrow inside the body
    const stem = inRoundedRect(px, py, 58, 56, 12, 26, 4);
    const head = inTriangle(px, py, 40, 74, 88, 74, 64, 100);
    if (stem || head) return BLUE;
  }
  return null;
}

/* ---------- PNG encoding ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(cv) {
  const { size, data } = cv;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(data.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- main ---------- */
mkdirSync(join(ROOT, 'icons'), { recursive: true });

// Render design at master*S resolution using 4 subsamples per axis for clean AA.
const hiSize = MASTER * S;
const hi = makeCanvas(hiSize);
const SUB = 2;
for (let y = 0; y < hiSize; y++) {
  for (let x = 0; x < hiSize; x++) {
    let acc = null;
    for (let dy = 0; dy < SUB && !acc; dy++) {
      for (let dx = 0; dx < SUB && !acc; dx++) {
        const ux = ((x + (dx + 0.5) / SUB) / S);
        const uy = ((y + (dy + 0.5) / SUB) / S);
        acc = paintMaster(ux, uy);
      }
    }
    if (acc) blendPixel(hi, x, y, acc);
  }
}

const master = downsample(hi, MASTER);
for (const size of [128, 48, 32, 16]) {
  const cv = size === MASTER ? master : downsample(master, size);
  const out = join(ROOT, 'icons', `icon${size}.png`);
  writeFileSync(out, encodePNG(cv));
  console.log('wrote', out);
}
