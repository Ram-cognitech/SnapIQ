// Does a hosted model do this better than the arithmetic, and what does it cost?
//
//   node experiments/ai-scan/run.mjs --task corners --provider gemini \
//     --image tmp/Scan.jpg --truth 619,1369 3164,1477 3595,4929 219,5152 \
//     --env ../../SmartTopIQ/smartopiq_vercel/supabase/functions/.env
//
// Tasks:
//   models   list the models the key can reach (nothing is guessed)
//   corners  ask for the four corners of the page, and score them
//   clean    ask an image model to straighten and de-shadow the page
//   qc       read both images back and report where the words differ
//
// Deliberately outside the application: no SDKs, no imports from public/, and
// nothing here is on the path a scan takes. It exists to answer a question.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import jpeg from 'jpeg-js';
import { PROVIDERS, PRICES, costOf, money } from './providers.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const list = (name) => {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return null;
  const out = [];
  for (let i = at + 1; i < args.length && !args[i].startsWith('--'); i++) out.push(args[i]);
  return out;
};

// Keys come from a file rather than the shell, because that is where they are.
const envFile = flag('env');
if (envFile && existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, '');
  }
}

const task = flag('task', 'corners');
const providerName = flag('provider', 'gemini');
const provider = PROVIDERS[providerName];
if (!provider) {
  console.error(`unknown provider: ${providerName} (gemini, openai, mistral)`);
  process.exit(1);
}
const key = process.env[provider.key];
if (!key) {
  console.error(`${provider.key} is not set - pass --env <file> or export it`);
  process.exit(1);
}

// --- pictures --------------------------------------------------------------

// Smaller costs less: tokens go with area, so halving each side quarters the
// bill. Enough of the page has to survive for its corners to be findable.
function asJpeg(path, longEdge) {
  // A PNG goes as it is: the point of this pass is to read back exactly what
  // the model produced, and there is no PNG decoder here to resize it with.
  if (path.toLowerCase().endsWith('.png')) {
    const bytes = readFileSync(path);
    return { base64: bytes.toString('base64'), mime: 'image/png', width: 0, height: 0, original: { width: 0, height: 0 } };
  }
  const raw = jpeg.decode(readFileSync(path), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
  const scale = Math.min(1, longEdge / Math.max(raw.width, raw.height));
  const width = Math.max(1, Math.round(raw.width * scale));
  const height = Math.max(1, Math.round(raw.height * scale));
  const step = Math.max(1, Math.floor(1 / scale));

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let dy = 0; dy < step; dy++) {
        for (let dx = 0; dx < step; dx++) {
          const sx = Math.min(raw.width - 1, x * step + dx);
          const sy = Math.min(raw.height - 1, y * step + dy);
          const s = (sy * raw.width + sx) * 4;
          r += raw.data[s]; g += raw.data[s + 1]; b += raw.data[s + 2]; n++;
        }
      }
      const d = (y * width + x) * 4;
      data[d] = r / n; data[d + 1] = g / n; data[d + 2] = b / n; data[d + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ data, width, height }, 82);
  return { base64: Buffer.from(encoded.data).toString('base64'), mime: 'image/jpeg', width, height, original: { width: raw.width, height: raw.height } };
}

const report = (usage, priceKey) => {
  const cost = costOf(priceKey, usage);
  console.log(`tokens     ${usage.in} in, ${usage.out} out`);
  console.log(`cost       ${money(cost)}   (${PRICES[priceKey]?.source ?? 'unpriced'})`);
  return cost;
};

// --- tasks -----------------------------------------------------------------

async function listModels() {
  if (providerName === 'gemini') {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': key },
    });
    const body = await response.json();
    for (const model of body.models ?? []) {
      const name = model.name.replace('models/', '');
      if (/image|flash|nano/i.test(name)) console.log(`${name}  [${(model.supportedGenerationMethods ?? []).join(',')}]`);
    }
    return;
  }
  if (providerName === 'openai') {
    const response = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } });
    const body = await response.json();
    for (const model of (body.data ?? []).map((m) => m.id).sort()) {
      if (/image|mini|nano/i.test(model)) console.log(model);
    }
    return;
  }
  const response = await fetch('https://api.mistral.ai/v1/models', { headers: { authorization: `Bearer ${key}` } });
  const body = await response.json();
  for (const model of (body.data ?? []).map((m) => m.id).sort()) console.log(model);
}

const CORNERS_PROMPT = `This photograph contains one sheet of paper - a document.
Find the four corners of that sheet.

Answer with JSON only, in this exact shape:
{"corners":[{"x":0.0,"y":0.0},{"x":0.0,"y":0.0},{"x":0.0,"y":0.0},{"x":0.0,"y":0.0}],"confident":true}

The four corners in order: top-left, top-right, bottom-right, bottom-left of the
document itself, as the document is oriented - not of the photograph.
x and y are fractions of the image width and height, between 0 and 1.
If there is no single clear document, set "confident" to false.`;

async function corners() {
  const path = flag('image');
  const size = Number(flag('size', '768'));
  const image = asJpeg(path, size);
  console.log(`photo      ${image.original.width} x ${image.original.height}, sent at ${image.width} x ${image.height}`);
  console.log(`model      ${flag('model', provider.vision)}`);

  const started = Date.now();
  const result = await provider.ask({
    model: flag('model', provider.vision),
    prompt: CORNERS_PROMPT,
    images: [{ data: image.base64, mime: image.mime }],
    key,
    json: true,
  });
  console.log(`took       ${Date.now() - started} ms`);

  let parsed = null;
  try {
    parsed = JSON.parse(result.text.replace(/^```json\s*|\s*```$/g, ''));
  } catch {
    console.log(`answer     unparseable: ${result.text.slice(0, 200)}`);
  }
  report(result.usage, flag('model') ? 'unpriced' : provider.priceKey);

  if (!parsed?.corners) return;
  // Asked for fractions and sometimes given pixels of the image that was sent.
  // Both are accepted rather than re-prompted: a model that ignores the format
  // once will ignore it again, and an experiment should measure what it does.
  const asPixels = parsed.corners.some((c) => c.x > 1.5 || c.y > 1.5);
  if (asPixels) console.log('note       answered in pixels, not fractions');
  const found = parsed.corners.map((c) => (asPixels
    ? [
      Math.round((c.x / image.width) * image.original.width),
      Math.round((c.y / image.height) * image.original.height),
    ]
    : [
      Math.round(c.x * image.original.width),
      Math.round(c.y * image.original.height),
    ]));
  console.log(`confident  ${parsed.confident}`);
  console.log(`corners    ${found.map(([x, y]) => `(${x},${y})`).join(' ')}`);

  const truth = list('truth')?.map((pair) => pair.split(',').map(Number));
  if (truth?.length === 4) {
    const off = found.map((c, i) => Math.hypot(c[0] - truth[i][0], c[1] - truth[i][1]));
    const diagonal = Math.hypot(image.original.width, image.original.height);
    console.log(`off by     ${off.map((d) => Math.round(d)).join(', ')} px`);
    console.log(`mean       ${(off.reduce((a, b) => a + b, 0) / 4).toFixed(0)} px  (${(off.reduce((a, b) => a + b, 0) / 4 / diagonal * 100).toFixed(2)}% of the diagonal)`);
  }
}

const CLEAN_PROMPT = `Here is a photograph of a document.
Return the document as a clean scan: straightened to a rectangle, the shadow
removed, the paper white, the text sharp and black.
Change nothing that is written on it. Every word, number and date must stay
exactly as it is.`;

async function clean() {
  const path = flag('image');
  const model = flag('model', provider.image);
  if (!model) {
    console.log(`${providerName} has no image-generation model; nothing to try.`);
    return;
  }
  const image = asJpeg(path, Number(flag('size', '1024')));
  console.log(`photo      sent at ${image.width} x ${image.height}`);
  console.log(`model      ${model}`);

  const started = Date.now();
  const result = await provider.ask({ model, prompt: CLEAN_PROMPT, images: [{ data: image.base64, mime: image.mime }], key, json: false });
  console.log(`took       ${Date.now() - started} ms`);
  report(result.usage, provider.imagePriceKey);

  if (!result.imageOut) {
    console.log(`answer     no image came back: ${result.text.slice(0, 300)}`);
    return;
  }
  mkdirSync('tmp/ai', { recursive: true });
  const out = `tmp/ai/${basename(path).replace(/\.[^.]+$/, '')}-${providerName}.png`;
  writeFileSync(out, Buffer.from(result.imageOut, 'base64'));
  console.log(`wrote      ${out}`);
  console.log('           now: --task qc --image <original> --against ' + out);
}

const READ_PROMPT = `Transcribe every word of this document, exactly as written,
reading order, including all numbers and dates. Plain text only, no commentary.`;

async function qc() {
  const before = flag('image');
  const after = flag('against');
  const model = flag('model', provider.vision);
  console.log(`model      ${model}`);

  const read = async (path) => {
    const image = asJpeg(path, Number(flag('size', '1024')));
    const result = await provider.ask({ model, prompt: READ_PROMPT, images: [{ data: image.base64, mime: image.mime }], key, json: false });
    return result;
  };

  const a = await read(before);
  const b = await read(after);
  const total = { in: a.usage.in + b.usage.in, out: a.usage.out + b.usage.out };
  report(total, provider.priceKey);

  const words = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s.,/-]/gu, ' ').split(/\s+/).filter(Boolean);
  const wordsA = words(a.text);
  const wordsB = words(b.text);
  const countOf = (listOfWords) => {
    const counts = new Map();
    for (const word of listOfWords) counts.set(word, (counts.get(word) ?? 0) + 1);
    return counts;
  };
  const countsA = countOf(wordsA);
  const countsB = countOf(wordsB);

  const lost = [];
  const gained = [];
  for (const [word, n] of countsA) if ((countsB.get(word) ?? 0) < n) lost.push(word);
  for (const [word, n] of countsB) if ((countsA.get(word) ?? 0) < n) gained.push(word);

  const numeric = (word) => /\d/.test(word);
  console.log(`\nwords      ${wordsA.length} before, ${wordsB.length} after`);
  console.log(`lost       ${lost.length ? lost.slice(0, 40).join(' ') : 'none'}`);
  console.log(`gained     ${gained.length ? gained.slice(0, 40).join(' ') : 'none'}`);
  const numbersLost = lost.filter(numeric);
  const numbersGained = gained.filter(numeric);
  console.log(`\nnumbers and dates changed: ${numbersLost.length || numbersGained.length ? 'YES' : 'no'}`);
  if (numbersLost.length) console.log(`  gone:    ${numbersLost.join(' ')}`);
  if (numbersGained.length) console.log(`  appeared: ${numbersGained.join(' ')}`);
  console.log('\n(An OCR pass disagrees with itself a little, so a word or two of');
  console.log(' difference is noise. A changed number is not.)');
}

const tasks = { models: listModels, corners, clean, qc };
if (!tasks[task]) {
  console.error(`unknown task: ${task} (models, corners, clean, qc)`);
  process.exit(1);
}
await tasks[task]();
