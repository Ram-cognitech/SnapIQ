// Find the corners of the page with the model, then put them on its edges.
//
//   node scripts/detect.mjs <photo.jpg> [outputDirectory] [--corners x,y x,y x,y x,y]
//
// The model is DocQuadNet-256 from MakeACopy (Apache 2.0): 256x256 RGB in,
// four corner heatmaps and a page mask out. Everything after it - the line
// fitting, the walk out to the edge of the sheet, the gradient check - is
// `refineCorners` in public/clean.js, the same code the browser will run.
//
// This is the harness the detector is judged with. Given corners to compare
// against, it prints how far off each one is.

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import ort from 'onnxruntime-node';
import jpeg from 'jpeg-js';
import { orderCorners, refineCorners } from '../public/clean.js';

const MODEL = 'public/models/docquadnet256.ort';
const IN = 256;
const OUT = 64;

// Turn a quarter turn clockwise.
function turn({ data, width, height }) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const to = ((x * height) + (height - 1 - y)) * 4;
      out[to] = data[from];
      out[to + 1] = data[from + 1];
      out[to + 2] = data[from + 2];
      out[to + 3] = 255;
    }
  }
  return { data: out, width: height, height: width };
}

// Where a point in the turned image was in the one before it.
const unturn = ([x, y], widthBefore) => [y, widthBefore - 1 - x];

// The model was trained on upright documents and shows it: a photograph taken
// in landscape scores about half what the same page scores upright. So it is
// asked four times, once at each quarter turn, and the turn it is surest about
// wins. Four runs of ~22 ms is a cheap way to stop caring which way up the
// phone was held.
export async function detectUpright(image, options = {}) {
  let candidate = image;
  let best = null;
  for (let turns = 0; turns < 4; turns++) {
    const result = await detect(candidate, options);
    const mean = result.confidence.reduce((a, b) => a + b, 0) / 4;
    if (!best || mean > best.mean) best = { ...result, mean, turns };
    if (turns < 3) candidate = turn(candidate);
  }

  // Back through the turns that were applied, to the photograph's own frame.
  let corners = best.corners;
  for (let t = best.turns; t > 0; t--) {
    const widthBefore = t % 2 ? image.height : image.width;
    corners = corners.map((point) => unturn(point, widthBefore));
  }

  // Which way up to render it.
  //
  // The turn the model preferred says whether the page is upright or on its
  // side, and that part is worth having: a document photographed in landscape
  // otherwise comes out of the straightening lying down. But the model cannot
  // tell up from down - it locates corners, it does not read - and on the test
  // page 0 and 180 degrees scored 0.86 against 0.87, near enough a coin toss.
  // Trusting that would print a page upside down.
  //
  // So only the quarter-turn is taken from it, and the half-turn is ignored.
  // Being on its side is a mistake nobody wants; being upside down needs text
  // to detect, and is one tap to fix.
  const ordered = orderCorners(corners);
  const shift = best.turns % 2 ? best.turns % 4 : 0;
  return {
    ...best,
    corners: shift ? [...ordered.slice(shift), ...ordered.slice(0, shift)] : ordered,
  };
}

export async function detect(image, { model = MODEL } = {}) {
  const { width: W, height: H } = image;

  // Letterboxed onto black, preserving the shape, exactly as the model was
  // trained. Stretching instead moves every corner.
  const scale = Math.min(IN / W, IN / H);
  const dw = Math.round(W * scale);
  const dh = Math.round(H * scale);
  const ox = Math.floor((IN - dw) / 2);
  const oy = Math.floor((IN - dh) / 2);

  const input = new Float32Array(3 * IN * IN);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(W - 1, Math.round(x / scale));
      const sy = Math.min(H - 1, Math.round(y / scale));
      const s = (sy * W + sx) * 4;
      const d = (y + oy) * IN + (x + ox);
      input[d] = image.data[s] / 255;
      input[IN * IN + d] = image.data[s + 1] / 255;
      input[2 * IN * IN + d] = image.data[s + 2] / 255;
    }
  }

  const session = await ort.InferenceSession.create(model);
  const started = Date.now();
  const outputs = await session.run({ input: new ort.Tensor('float32', input, [1, 3, IN, IN]) });
  const took = Date.now() - started;

  const heat = outputs.corner_heatmaps.data;
  const corners = [];
  const confidence = [];
  for (let c = 0; c < 4; c++) {
    let peak = -Infinity;
    let bx = 0;
    let by = 0;
    for (let i = 0; i < OUT * OUT; i++) {
      const value = heat[c * OUT * OUT + i];
      if (value > peak) { peak = value; bx = i % OUT; by = (i - (i % OUT)) / OUT; }
    }
    // Centre of mass of the peak's neighbours, for a sub-cell answer: each
    // cell of the heatmap stands for sixteen pixels of the input.
    let weight = 0;
    let sx = 0;
    let sy = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = bx + dx;
        const y = by + dy;
        if (x < 0 || y < 0 || x >= OUT || y >= OUT) continue;
        const w = Math.exp(heat[c * OUT * OUT + y * OUT + x] - peak);
        weight += w;
        sx += w * x;
        sy += w * y;
      }
    }
    const px = (sx / weight + 0.5) * (IN / OUT);
    const py = (sy / weight + 0.5) * (IN / OUT);
    corners.push([
      Math.max(0, Math.min(W - 1, Math.round((px - ox) / scale))),
      Math.max(0, Math.min(H - 1, Math.round((py - oy) / scale))),
    ]);
    confidence.push(1 / (1 + Math.exp(-peak)));
  }
  return { corners, confidence, took };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('detect.mjs')) {
  const args = process.argv.slice(2);
  let given = null;
  const flag = args.indexOf('--corners');
  if (flag !== -1) given = args.splice(flag, 6).slice(1).map((pair) => pair.split(',').map(Number));
  const [file, outDir = 'tmp'] = args;
  if (!file || !existsSync(file)) {
    console.error('usage: node scripts/detect.mjs <photo.jpg> [outputDirectory] [--corners x,y ...]');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const raw = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
  const image = { data: new Uint8ClampedArray(raw.data), width: raw.width, height: raw.height };
  console.log(`photo      ${image.width} x ${image.height}`);

  const { corners, confidence, took, turns } = await detectUpright(image);
  console.log(`upright    ${turns * 90} degrees`);
  console.log(`model      ${corners.map(([x, y]) => `(${x},${y})`).join(' ')}  in ${took} ms`);
  console.log(`confidence ${confidence.map((c) => c.toFixed(2)).join(' ')}`);

  const t0 = Date.now();
  const refined = refineCorners(image, corners);
  console.log(`refined    ${refined.map(([x, y]) => `(${x},${y})`).join(' ')}  in ${Date.now() - t0} ms`);

  if (given) {
    const off = (quad) => quad.map((c, i) => Math.hypot(c[0] - given[i][0], c[1] - given[i][1]));
    const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
    const before = off(corners);
    const after = off(refined);
    console.log(`model off  ${before.map((d) => Math.round(d)).join(', ')}  mean ${mean(before).toFixed(0)} px`);
    console.log(`refined    ${after.map((d) => Math.round(d)).join(', ')}  mean ${mean(after).toFixed(0)} px`);
  }

  console.log(`\nnode scripts/try.mjs ${file} ${outDir} --corners ${refined.map(([x, y]) => `${x},${y}`).join(' ')}`);
  console.log(`(file ${basename(file)})`);
}
