// Run the pipeline over a real photograph and write out what it did.
//
//   node scripts/try.mjs <photo.jpg> [outputDirectory]
//
// Synthetic tests say the arithmetic is right; only a real photograph says
// whether the page is found on a cluttered desk, under a hard shadow, next to
// something else white. This writes four images so the answer can be looked at
// rather than argued about: the photo with the corners drawn on, the
// straightened page, and the cleaned page at each tone.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { deflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import {
  cleanPage, detectPage, enhance, luminance, otsu, outputSize, polygonArea,
  shrinkGray, warpPerspective, TONES,
} from '../public/clean.js';

function main() {
  const args = process.argv.slice(2);
  // Corners can be given instead of detected: --corners x1,y1 x2,y2 x3,y3 x4,y4
  // clockwise from the top-left. public/corners.html prints this line for you.
  // It is how the straightening and the shadow removal get judged on their own,
  // without a failure in the detector hiding what they did.
  let given = null;
  const flag = args.indexOf('--corners');
  if (flag !== -1) {
    given = args.splice(flag, 6).slice(1).map((pair) => pair.split(',').map(Number));
    if (given.length !== 4 || given.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
      console.error('--corners needs four x,y pairs, clockwise from the top-left');
      process.exit(1);
    }
  }
  const [file, outDir = 'tmp'] = args;
  if (!file) {
    console.error('usage: node scripts/try.mjs <photo.jpg> [outputDirectory] [--corners x,y x,y x,y x,y]');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const raw = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
  const image = { data: new Uint8ClampedArray(raw.data), width: raw.width, height: raw.height };
  console.log(`photo      ${image.width} x ${image.height}`);

  const started = Date.now();
  const found = detectPage(image);
  const took = Date.now() - started;

  if (!found) {
    console.log('detected   NOT FOUND');
  } else {
    console.log(`detected   ${found.map(([x, y]) => `(${x},${y})`).join(' ')}   in ${took} ms`);
    console.log(`           ${((polygonArea(found) / (image.width * image.height)) * 100).toFixed(1)}% of the frame`);
  }

  const corners = given ?? found;
  if (given) {
    console.log(`given      ${given.map(([x, y]) => `(${x},${y})`).join(' ')}`);
    console.log(`           ${((polygonArea(given) / (image.width * image.height)) * 100).toFixed(1)}% of the frame`);
    if (found) {
      // How far the detector was, corner by corner, in pixels.
      const off = found.map((c, i) => Math.round(Math.hypot(c[0] - given[i][0], c[1] - given[i][1])));
      console.log(`           detector off by ${off.join(', ')} px`);
    }
  }

  const gray = luminance(image);
  console.log(`threshold  ${otsu(shrinkGray(gray, 320))}`);

  const name = basename(file).replace(/\.[^.]+$/, '');
  write(`${outDir}/${name}-1-corners.png`, withCorners(image, corners));
  write(`${outDir}/${name}-0-mask.png`, maskImage(image));

  if (corners) {
    const size = outputSize(corners, 1200);
    console.log(`output     ${size.width} x ${size.height}`);
    const straight = warpPerspective(image, corners, size);
    if (straight) write(`${outDir}/${name}-2-straight.png`, straight);
  }

  for (const tone of Object.keys(TONES)) {
    const cleaned = cleanPage(image, corners, { maxEdge: 1200, tone });
    write(`${outDir}/${name}-3-${tone}.png`, cleaned);
  }
  console.log(`wrote      ${outDir}/${name}-*.png`);
}

// What the detector actually sees: everything above the threshold, in white.
function maskImage(source) {
  const small = shrinkGray(luminance(source), 320);
  const threshold = otsu(small);
  const out = { data: new Uint8ClampedArray(small.width * small.height * 4), width: small.width, height: small.height };
  for (let i = 0; i < small.data.length; i++) {
    const v = small.data[i] > threshold ? 255 : 0;
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

// --- drawing ---------------------------------------------------------------


function withCorners(source, quad) {
  // A shrunken copy so the marks are visible at a glance.
  const scale = Math.min(1, 1000 / Math.max(source.width, source.height));
  const w = Math.round(source.width * scale);
  const h = Math.round(source.height * scale);
  const out = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(source.width - 1, Math.round(x / scale));
      const sy = Math.min(source.height - 1, Math.round(y / scale));
      const from = (sy * source.width + sx) * 4;
      const to = (y * w + x) * 4;
      out.data[to] = source.data[from];
      out.data[to + 1] = source.data[from + 1];
      out.data[to + 2] = source.data[from + 2];
      out.data[to + 3] = 255;
    }
  }
  if (!quad) return out;
  const points = quad.map(([x, y]) => [x * scale, y * scale]);
  for (let i = 0; i < 4; i++) line(out, points[i], points[(i + 1) % 4]);
  points.forEach((p, i) => dot(out, p, i));
  return out;
}

function line(image, [x1, y1], [x2, y2]) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x1 + ((x2 - x1) * i) / steps);
    const y = Math.round(y1 + ((y2 - y1) * i) / steps);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) set(image, x + dx, y + dy, [255, 0, 255]);
    }
  }
}

function dot(image, [x, y], index) {
  // Top-left red, then green, blue, yellow clockwise - so a wrong corner order
  // is visible at a glance.
  const COLOURS = [[255, 60, 60], [60, 255, 60], [60, 140, 255], [255, 220, 40]];
  for (let dy = -7; dy <= 7; dy++) {
    for (let dx = -7; dx <= 7; dx++) {
      if (dx * dx + dy * dy <= 49) set(image, Math.round(x) + dx, Math.round(y) + dy, COLOURS[index]);
    }
  }
}

function set({ data, width, height }, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
}

// --- PNG out ---------------------------------------------------------------

function write(path, { data, width, height }) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    rows[at++] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rows[at++] = data[i];
      rows[at++] = data[i + 1];
      rows[at++] = data[i + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

let CRC;
function chunk(type, data) {
  CRC ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let c = 0xffffffff;
  for (const byte of body) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, crc]);
}

main();
