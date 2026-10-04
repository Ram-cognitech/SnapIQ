// Draws the app icons: `node scripts/icons.mjs`.
//
// A script rather than two binary files nobody can edit - the icons are a
// coloured square with a page on it, and when the real mark exists this is one
// place to change. Android will not offer to install a web app without real
// PNG icons at 192 and 512, which is why they exist at all.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const INK = [0x3b, 0x5b, 0xdb];        // the accent blue
const PAPER = [0xff, 0xff, 0xff];
const LINE = [0xc3, 0xcd, 0xf5];

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

function icon(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 2;     // truecolour

  // The page: a rectangle with a folded corner, and a few lines of "text".
  const margin = Math.round(size * 0.22);
  const pageW = size - margin * 2;
  const fold = Math.round(pageW * 0.3);
  const rows = [];

  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);     // filter byte 0, then RGB
    for (let x = 0; x < size; x++) {
      let colour = INK;
      const insidePage = x >= margin && x < size - margin && y >= margin && y < size - margin;
      // The top-right corner is cut away, which reads as a folded page.
      const inFold = insidePage && (size - margin - x) + (y - margin) < fold;
      if (insidePage && !inFold) {
        colour = PAPER;
        // Lines of writing, evenly spaced down the lower two thirds.
        const fromTop = y - margin;
        const step = Math.max(2, Math.round(pageW * 0.14));
        const thickness = Math.max(1, Math.round(pageW * 0.045));
        const inset = Math.round(pageW * 0.16);
        const onLine = fromTop > pageW * 0.34 && fromTop % step < thickness;
        const withinText = x > margin + inset && x < size - margin - inset;
        if (onLine && withinText) colour = LINE;
      }
      row[1 + x * 3] = colour[0];
      row[2 + x * 3] = colour[1];
      row[3 + x * 3] = colour[2];
    }
    rows.push(row);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const file = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(file, icon(size));
  console.log(`public/icon-${size}.png`);
}
