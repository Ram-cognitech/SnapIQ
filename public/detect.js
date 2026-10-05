// Finding the four corners of the page, in the phone's own browser.
//
// DocQuadNet-256 from MakeACopy (Apache 2.0, see NOTICE): a 256x256 RGB image
// in, four corner heatmaps and a page mask out. Everything after it - choosing
// the quarter turn, fitting the page's edges, the walk out to where the sheet
// ends - is ours, in clean.js.
//
// Nothing here is allowed to break the capture page. The model is fetched in
// the background, the session is built once, and every failure returns null so
// the brightness detector and the draggable corners carry on as before.

const IN = 256;
const OUT = 64;
const MODEL = '/models/docquadnet256.ort';
const RUNTIME = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.min.js';

let sessionPromise = null;

async function runtime() {
  if (globalThis.ort) return globalThis.ort;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = RUNTIME;
    script.onload = resolve;
    script.onerror = () => reject(new Error('the runtime could not be fetched'));
    document.head.append(script);
  });
  if (!globalThis.ort) throw new Error('the runtime did not load');
  globalThis.ort.env.wasm.numThreads = 1;      // no cross-origin isolation here
  return globalThis.ort;
}

// Built once and kept. Started early by `warmUp`, so the wait does not land on
// the person who has just taken a photograph.
export function warmUp() {
  sessionPromise ??= (async () => {
    const ort = await runtime();
    return ort.InferenceSession.create(MODEL, { executionProviders: ['wasm'] });
  })();
  return sessionPromise.catch(() => null);
}

// Draw the photograph into a 256x256 square, turned a quarter at a time and
// letterboxed onto black, which is how the model was trained.
//
// The canvas does the turning, so the photograph itself is never rotated: four
// passes over twelve megapixels would cost more than the model does.
function square(source, turns) {
  const canvas = document.createElement('canvas');
  canvas.width = IN;
  canvas.height = IN;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#000';
  context.fillRect(0, 0, IN, IN);

  const sideways = turns % 2 === 1;
  const width = sideways ? source.height : source.width;
  const height = sideways ? source.width : source.height;
  const scale = Math.min(IN / width, IN / height);
  const w = width * scale;
  const h = height * scale;

  context.save();
  context.translate(IN / 2, IN / 2);
  context.rotate((turns * Math.PI) / 2);
  // After the rotation the picture is drawn in its own orientation, centred.
  const dw = sideways ? h : w;
  const dh = sideways ? w : h;
  context.drawImage(source, -dw / 2, -dh / 2, dw, dh);
  context.restore();

  const pixels = context.getImageData(0, 0, IN, IN).data;
  const input = new Float32Array(3 * IN * IN);
  for (let i = 0, p = 0; p < IN * IN; i += 4, p++) {
    input[p] = pixels[i] / 255;
    input[IN * IN + p] = pixels[i + 1] / 255;
    input[2 * IN * IN + p] = pixels[i + 2] / 255;
  }
  return { input, scale, w, h, sideways };
}

const peakOf = (heat, channel) => {
  let best = -Infinity;
  let bx = 0;
  let by = 0;
  for (let i = 0; i < OUT * OUT; i++) {
    const value = heat[channel * OUT * OUT + i];
    if (value > best) { best = value; bx = i % OUT; by = (i - (i % OUT)) / OUT; }
  }
  // Centre of mass of the peak's neighbours: each cell stands for sixteen
  // pixels of the input, so the nearest cell is not accurate enough.
  let weight = 0;
  let sx = 0;
  let sy = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = bx + dx;
      const y = by + dy;
      if (x < 0 || y < 0 || x >= OUT || y >= OUT) continue;
      const w = Math.exp(heat[channel * OUT * OUT + y * OUT + x] - best);
      weight += w;
      sx += w * x;
      sy += w * y;
    }
  }
  return {
    x: (sx / weight + 0.5) * (IN / OUT),
    y: (sy / weight + 0.5) * (IN / OUT),
    confidence: 1 / (1 + Math.exp(-best)),
  };
};

// source: anything drawImage accepts - the canvas the capture page already has.
// Returns { corners, confidence, turns } in the photograph's own pixels, or
// null if the model is not available.
export async function detectCorners(source, { width, height }) {
  let session;
  try {
    session = await warmUp();
    if (!session) return null;
  } catch {
    return null;
  }

  const ort = globalThis.ort;
  let best = null;

  for (let turns = 0; turns < 4; turns++) {
    const prepared = square(source, turns);
    let outputs;
    try {
      outputs = await session.run({ input: new ort.Tensor('float32', prepared.input, [1, 3, IN, IN]) });
    } catch {
      return null;
    }
    const heat = outputs.corner_heatmaps.data;
    const found = [0, 1, 2, 3].map((channel) => peakOf(heat, channel));
    const mean = found.reduce((total, c) => total + c.confidence, 0) / 4;
    if (!best || mean > best.mean) best = { mean, turns, found, prepared };
  }

  // Out of the square, back into the photograph.
  const { prepared, turns } = best;
  const offsetX = (IN - (prepared.sideways ? prepared.h : prepared.w)) / 2;
  const offsetY = (IN - (prepared.sideways ? prepared.w : prepared.h)) / 2;

  const corners = best.found.map(({ x, y }) => {
    // Undo the letterbox, then the quarter turns, in the square's own frame.
    let px = (x - offsetX) / prepared.scale;
    let py = (y - offsetY) / prepared.scale;
    for (let t = turns; t > 0; t--) {
      const across = t % 2 ? height : width;
      [px, py] = [py, across - 1 - px];
    }
    return [
      Math.max(0, Math.min(width - 1, Math.round(px))),
      Math.max(0, Math.min(height - 1, Math.round(py))),
    ];
  });

  return { corners, confidence: best.found.map((c) => c.confidence), turns, mean: best.mean };
}
