// Turning a photograph of a page into a scan of a page.
//
// All of it runs in the phone's browser: a Worker has 10 ms of CPU on the free
// plan, and doing it here means the work costs nothing at any volume, the
// camera's metadata never leaves the device, and the person holding the phone
// sees the result at once and can correct it.
//
// Four steps, in this order and for a reason:
//
//   1. find the page in the photo          (detectPage)
//   2. straighten it to a rectangle        (warpPerspective)
//   3. take the shadow of the room off it  (removeShadow)
//   4. stretch what is left to full range  (autoContrast)
//
// Straightening happens at the photo's own resolution, before anything is
// shrunk: warping an already-shrunk image resamples it twice and softens the
// small text that was the point of scanning.
//
// Everything here is a plain function over {data, width, height}, with no DOM,
// so it can be tested without a browser - see tests/unit/clean.test.js.

export const MAX_LONG_EDGE = 3500;      // 300 DPI on A4 (docs/api.md section 7)

// --- 1. where is the page? -------------------------------------------------

export function luminance({ data, width, height }) {
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    // Rec. 601 weights: green carries most of what the eye reads as brightness.
    gray[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return { data: gray, width, height };
}

// Shrink by whole-pixel averaging. Cheap, and good enough for deciding where
// the paper is - the decision is then applied to the full-size image.
export function shrinkGray({ data, width, height }, maxEdge) {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / maxEdge));
  if (step === 1) return { data, width, height };
  const w = Math.max(1, Math.floor(width / step));
  const h = Math.max(1, Math.floor(height / step));
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let total = 0;
      let n = 0;
      for (let dy = 0; dy < step; dy++) {
        const sy = y * step + dy;
        if (sy >= height) break;
        for (let dx = 0; dx < step; dx++) {
          const sx = x * step + dx;
          if (sx >= width) break;
          total += data[sy * width + sx];
          n++;
        }
      }
      out[y * w + x] = total / n;
    }
  }
  return { data: out, width: w, height: h, step };
}

// Otsu's method: the threshold that best splits the histogram into two groups.
// A page against a desk is exactly that shape of problem.
export function otsu({ data }) {
  const histogram = new Uint32Array(256);
  for (const value of data) histogram[value]++;
  const total = data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let weightBelow = 0;
  let sumBelow = 0;
  let bestVariance = -1;
  // Between two well separated groups every threshold in the gap separates
  // them equally well. Taking the first one puts the line right against the
  // darker group, where a little noise pushes background pixels across it, so
  // the whole run of equally good thresholds is remembered and the middle of
  // it used.
  let plateauFrom = -1;
  let plateauTo = -1;
  for (let t = 0; t < 256; t++) {
    weightBelow += histogram[t];
    if (weightBelow === 0) continue;
    const weightAbove = total - weightBelow;
    if (weightAbove === 0) break;
    sumBelow += t * histogram[t];
    const meanBelow = sumBelow / weightBelow;
    const meanAbove = (sum - sumBelow) / weightAbove;
    const variance = weightBelow * weightAbove * (meanBelow - meanAbove) ** 2;
    if (variance > bestVariance * (1 + 1e-9)) {
      bestVariance = variance;
      plateauFrom = plateauTo = t;
    } else if (variance >= bestVariance * (1 - 1e-9)) {
      plateauTo = t;
    }
  }
  // An image of one flat tone has no two groups to find. Saying so lets the
  // caller give up instead of calling the whole frame a page.
  if (bestVariance <= 0) return -1;
  return (plateauFrom + plateauTo) >> 1;
}

// The four corners of the page, in full-resolution coordinates, or null when
// nothing page-shaped is there - in which case the whole frame is used, which
// is the honest outcome rather than a confident wrong crop.
export function detectPage(image, { minAreaFraction = 0.12, minScore = 0.08 } = {}) {
  const small = shrinkGray(luminance(image), 500);
  const { data, width, height } = small;
  const step = small.step ?? 1;

  const threshold = otsu(small);
  if (threshold < 0) return null;          // one flat tone: there is no page here

  // The page is in the brighter group - but so is every other pale thing in
  // the room, and they touch, which is why what follows is not simply "take
  // the biggest".
  const bright = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) bright[i] = data[i] > threshold ? 1 : 0;

  const gradient = sobel(small);
  const toPoints = (pixels) => pixels.map((index) => {
    const x = index % width;
    return [x, (index - x) / width];
  });

  // Several degrees of shrinking, because the right one depends on how wide
  // the join is between the page and whatever pale thing it is lying on. At
  // zero, a page alone on a desk is found immediately; further in, a page
  // resting on another page finally comes apart from it. Every candidate is
  // grown back and judged on its merits, so nothing rests on picking the
  // erosion correctly.
  let best = null;
  for (const erosion of [0, 2, 4, 7]) {
    const seeds = erosion ? erodeMask(bright, width, height, erosion) : bright;
    for (const piece of componentsOf(seeds, width, height, 3)) {
      const pixels = erosion ? regrow(piece, bright, width, height, erosion) : piece;
      if (pixels.length < width * height * minAreaFraction) continue;
      const quad = maxAreaQuad(convexHull(toPoints(pixels)));
      if (!quad) continue;
      const score = scoreQuad(quad, pixels.length, gradient, width, height);
      if (!best || score > best.score) best = { score, quad };
    }
  }

  // Nothing page-shaped with real edges under it. Saying so is the honest
  // answer; the capture page then offers the whole frame and the corners can
  // be dragged.
  if (!best || best.score < minScore) return null;

  // Back to the photograph's own coordinates, and nudged to the middle of the
  // block each shrunken pixel stood for.
  const back = ([x, y]) => [
    Math.min(image.width - 1, Math.round((x + 0.5) * step)),
    Math.min(image.height - 1, Math.round((y + 0.5) * step)),
  ];
  return orderCorners(best.quad).map(back);
}

// --- 1b. the pieces the detector is built from -----------------------------

// Gradient strength, which is what tells a real page edge from a line drawn
// across paper. Brightness alone cannot: a page lying on another page is one
// bright region, and any boundary we invent inside it has no edge under it.
export function sobel({ data, width, height }) {
  const out = new Uint8ClampedArray(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -data[i - width - 1] + data[i - width + 1]
        - 2 * data[i - 1] + 2 * data[i + 1]
        - data[i + width - 1] + data[i + width + 1];
      const gy =
        -data[i - width - 1] - 2 * data[i - width] - data[i - width + 1]
        + data[i + width - 1] + 2 * data[i + width] + data[i + width + 1];
      out[i] = Math.min(255, Math.hypot(gx, gy) >> 2);
    }
  }
  return { data: out, width, height };
}

// Shrink a mask inwards. Two bright things that touch along a thin join come
// apart here, which is the only way to consider them separately - a page lying
// on another page is otherwise a single region for ever.
export function erodeMask(mask, width, height, radius) {
  let current = mask;
  for (let step = 0; step < radius; step++) {
    const next = new Uint8Array(current.length);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        next[i] = current[i] && current[i - 1] && current[i + 1]
          && current[i - width] && current[i + width] ? 1 : 0;
      }
    }
    current = next;
  }
  return current;
}

// Grow a shrunken piece back by exactly as much as was taken off it, staying
// inside the original bright region.
//
// It must be *bounded*. Flooding the whole region instead - which is what the
// first attempt did - restores the entire connected component by definition,
// re-joining the very things the erosion had just separated, so every erosion
// depth returned an identical answer.
function regrow(seed, full, width, height, steps) {
  let current = new Uint8Array(full.length);
  for (const index of seed) current[index] = 1;

  for (let step = 0; step < steps; step++) {
    const next = new Uint8Array(full.length);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        if (!full[i]) continue;
        next[i] = current[i] || current[i - 1] || current[i + 1]
          || current[i - width] || current[i + width] ? 1 : 0;
      }
    }
    current = next;
  }

  const pixels = [];
  for (let i = 0; i < current.length; i++) if (current[i]) pixels.push(i);
  return pixels;
}

// Every connected piece, biggest first.
function componentsOf(mask, width, height, keep = 4) {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const found = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    const pixels = [];
    while (head < tail) {
      const index = queue[head++];
      pixels.push(index);
      const x = index % width;
      const y = (index - x) / width;
      const push = (next) => { if (mask[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; } };
      if (x > 0) push(index - 1);
      if (x < width - 1) push(index + 1);
      if (y > 0) push(index - width);
      if (y < height - 1) push(index + width);
    }
    found.push(pixels);
  }
  return found.sort((a, b) => b.length - a.length).slice(0, keep);
}

// The outline of a set of points, by Andrew's monotone chain.
export function convexHull(points) {
  if (points.length < 4) return points.slice();
  const sorted = [...points].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const out = [];
    for (const point of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], point) <= 0) out.pop();
      out.push(point);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

// The biggest four-cornered shape inside that outline. A page photographed at
// an angle is a quadrilateral, so this is the shape being looked for - and it
// is far steadier than reading the extremes of the two diagonals, which is
// what the first version did and which any ragged edge could pull about.
export function maxAreaQuad(hull) {
  const n = hull.length;
  if (n < 4) return null;
  if (n === 4) return hull.slice();

  const triangle = (a, b, c) =>
    Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;

  let best = null;
  let bestArea = 0;
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < n; k++) {
      // The diagonal i-k, then the furthest point on each side of it.
      let j = -1;
      let jArea = 0;
      for (let m = i + 1; m < k; m++) {
        const area = triangle(hull[i], hull[m], hull[k]);
        if (area > jArea) { jArea = area; j = m; }
      }
      let l = -1;
      let lArea = 0;
      for (let m = k + 1; m < n + i; m++) {
        const area = triangle(hull[k], hull[m % n], hull[i]);
        if (area > lArea) { lArea = area; l = m % n; }
      }
      if (j < 0 || l < 0) continue;
      if (jArea + lArea > bestArea) {
        bestArea = jArea + lArea;
        best = [hull[i], hull[j], hull[k], hull[l]];
      }
    }
  }
  return best;
}

// Clockwise from the top-left, which is the order everything downstream wants.
export function orderCorners(quad) {
  const cx = quad.reduce((total, [x]) => total + x, 0) / quad.length;
  const cy = quad.reduce((total, [, y]) => total + y, 0) / quad.length;
  const byAngle = [...quad].sort((a, b) =>
    Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let first = 0;
  let bestSum = Infinity;
  byAngle.forEach(([x, y], index) => {
    if (x + y < bestSum) { bestSum = x + y; first = index; }
  });
  return [0, 1, 2, 3].map((offset) => byAngle[(first + offset) % 4]);
}

// How much this quadrilateral looks like a page: its sides should sit on real
// edges, it should be filled by the bright region it came from, and it should
// not be a sliver. The edge term is what rejects a boundary drawn across the
// middle of a sheet of paper, where there is nothing to see.
function scoreQuad(quad, pixelCount, gradient, width, height) {
  const area = polygonArea(quad);
  if (area < width * height * 0.1) return 0;

  let support = 0;
  let samples = 0;
  for (let side = 0; side < 4; side++) {
    const [x1, y1] = quad[side];
    const [x2, y2] = quad[(side + 1) % 4];
    const steps = Math.max(8, Math.round(Math.hypot(x2 - x1, y2 - y1)));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x1 + ((x2 - x1) * s) / steps);
      const y = Math.round(y1 + ((y2 - y1) * s) / steps);
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) { samples++; continue; }
      // The strongest gradient within a pixel or two of the line, so a corner
      // that is a little out does not score zero.
      let strongest = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const gx = x + dx;
          const gy = y + dy;
          if (gx < 0 || gy < 0 || gx >= width || gy >= height) continue;
          const value = gradient.data[gy * width + gx];
          if (value > strongest) strongest = value;
        }
      }
      support += strongest;
      samples++;
    }
  }
  const edge = samples ? support / samples / 255 : 0;
  const fill = Math.min(1, pixelCount / area);        // an L-shape fills its quad badly
  const shape = Math.min(area / (width * height), 0.95);
  return edge * fill * fill * Math.sqrt(shape);
}

function largestComponent(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let best = null;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    const pixels = [];

    while (head < tail) {
      const index = queue[head++];
      pixels.push(index);
      const x = index % width;
      const y = (index - x) / width;
      // Four-way is enough and half the work of eight.
      if (x > 0) push(index - 1);
      if (x < width - 1) push(index + 1);
      if (y > 0) push(index - width);
      if (y < height - 1) push(index + width);
    }
    if (!best || pixels.length > best.size) best = { size: pixels.length, pixels };

    function push(next) {
      if (mask[next] && !seen[next]) {
        seen[next] = 1;
        queue[tail++] = next;
      }
    }
  }
  return best;
}

export function polygonArea(points) {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    total += x1 * y2 - x2 * y1;
  }
  return Math.abs(total) / 2;
}

const distance = ([x1, y1], [x2, y2]) => Math.hypot(x2 - x1, y2 - y1);

// How big the straightened page should be: the longest opposing sides, so
// nothing is squashed, capped at what 300 DPI on A4 needs.
export function outputSize([tl, tr, br, bl], maxEdge = MAX_LONG_EDGE) {
  let width = Math.round(Math.max(distance(tl, tr), distance(bl, br)));
  let height = Math.round(Math.max(distance(tl, bl), distance(tr, br)));
  width = Math.max(1, width);
  height = Math.max(1, height);
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// --- 1c. putting the corners exactly on the page ---------------------------

// Move four roughly-right corners onto the page's actual edges.
//
// Not by nudging each corner towards whatever gradient is nearest it: at the
// corner of a spiral notebook the pages below are also an edge, and a local
// search walks onto them. Instead each of the four sides is fitted as a line,
// using samples taken along its middle where the edge is clean and far from
// the clutter at the ends, and the corners are where consecutive lines meet.
//
// So every corner is decided by two edges and some hundreds of pixels rather
// than by its own neighbourhood. A corner that was badly out is pulled back by
// evidence that was never near it - which is exactly the case that needs help,
// since the lower-right of a bound notebook is where a model is least sure.
export function refineCorners(image, quad, {
  working = 700,       // resolution the search runs at
  reach = 0.02,        // how far to look for the edge, as a share of the long side
  samples = 48,
  trim = 0.15,         // ignore this much of each end, where corners confuse things
  maxShift = 0.04,     // a corner that wants to move further than this is not believed
} = {}) {
  const small = shrinkGray(luminance(image), working);
  const step = small.step ?? 1;
  const gradient = sobel(small);
  const span = Math.max(4, Math.round(Math.max(small.width, small.height) * reach));
  const limit = Math.max(8, Math.round(Math.max(image.width, image.height) * maxShift));

  // Judge "is this still the page?" on the flattened image, not the raw one.
  // A page under a hard shadow is two very different brightnesses but one
  // uniform sheet; dividing by its own slow-changing lighting is what makes
  // that uniformity visible, and it is already how the shadow is removed.
  const flat = flatten(small);

  const scaled = quad.map(([x, y]) => [x / step, y / step]);

  // What the page looks like, measured from well inside it so no edge, no
  // shadow boundary and nothing beyond the page can colour the answer.
  const centreX = scaled.reduce((t, [x]) => t + x, 0) / 4;
  const centreY = scaled.reduce((t, [, y]) => t + y, 0) / 4;
  const inside = [];
  for (let gy = 0; gy < 12; gy++) {
    for (let gx = 0; gx < 12; gx++) {
      // A grid over the quad pulled a quarter of the way to its middle.
      const u = (gx + 0.5) / 12;
      const v = (gy + 0.5) / 12;
      const top = [scaled[0][0] + (scaled[1][0] - scaled[0][0]) * u, scaled[0][1] + (scaled[1][1] - scaled[0][1]) * u];
      const bottom = [scaled[3][0] + (scaled[2][0] - scaled[3][0]) * u, scaled[3][1] + (scaled[2][1] - scaled[3][1]) * u];
      let x = top[0] + (bottom[0] - top[0]) * v;
      let y = top[1] + (bottom[1] - top[1]) * v;
      x = centreX + (x - centreX) * 0.75;
      y = centreY + (y - centreY) * 0.75;
      const px = Math.round(x);
      const py = Math.round(y);
      if (px < 0 || py < 0 || px >= small.width || py >= small.height) continue;
      inside.push(flat.data[py * small.width + px]);
    }
  }
  if (inside.length < 24) return quad;
  inside.sort((a, b) => a - b);
  const pageLevel = inside[inside.length >> 1];
  const spread = inside[Math.floor(inside.length * 0.84)] - inside[Math.floor(inside.length * 0.16)];
  // Off the page when it is darker than the sheet by more than its own
  // variation - with a floor, so a very even page does not trip on nothing.
  const offPage = pageLevel - Math.max(14, spread * 1.6);

  const lines = [];

  for (let side = 0; side < 4; side++) {
    const [x1, y1] = scaled[side];
    const [x2, y2] = scaled[(side + 1) % 4];
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (length < 8) return quad;
    const dx = (x2 - x1) / length;
    const dy = (y2 - y1) / length;
    const nx = -dy;                       // the direction to search in
    const ny = dx;

    const found = [];
    for (let s = 0; s < samples; s++) {
      const along = trim + ((1 - 2 * trim) * s) / (samples - 1);
      const bx = x1 + dx * length * along;
      const by = y1 + dy * length * along;

      // Walk outwards from inside the sheet and stop where it stops being the
      // sheet. Taking the strongest gradient in the neighbourhood instead
      // makes the line hop onto a different edge altogether: under a bound
      // notebook, the stack of pages below is a stronger edge than the page,
      // and the bottom corners march a hundred pixels down onto it. Leaving
      // the page can only happen once, so the first departure is the edge.
      const sample = (offset) => {
        const px = Math.round(bx + nx * offset);
        const py = Math.round(by + ny * offset);
        if (px < 1 || py < 1 || px >= small.width - 1 || py >= small.height - 1) return null;
        return flat.data[py * small.width + px];
      };

      let at = null;
      let leaving = 0;
      for (let offset = Math.round(span * 0.75); offset >= -span; offset--) {
        const value = sample(offset);
        if (value === null) continue;
        if (value < offPage) {
          // Two in a row, so a speck of dust or a letter is not an edge.
          if (++leaving >= 2) { at = offset + 1; break; }
        } else {
          leaving = 0;
        }
      }
      // Nothing stopped looking like the page: this sheet is lying on other
      // white sheets, and leaving it never shows. Fall back to the strongest
      // edge, weighted towards where the page was thought to be so a boundary
      // further out has to be clearly better to win. Second choice, because
      // where the page visibly ends is the surer answer when it exists.
      if (at === null) {
        let best = 0;
        for (let offset = -span; offset <= span; offset++) {
          const px = Math.round(bx + nx * offset);
          const py = Math.round(by + ny * offset);
          if (px < 1 || py < 1 || px >= small.width - 1 || py >= small.height - 1) continue;
          const nearness = Math.exp(-0.5 * (offset / (span * 0.6)) ** 2);
          const score = gradient.data[py * small.width + px] * nearness;
          if (score > best) { best = score; at = offset; }
        }
        if (at === null) continue;
      }

      // The gradient decides the last pixel or two, where it is reliable
      // because we already know the edge is here.
      let bestAt = at;
      let bestEdge = -1;
      for (let offset = at - 2; offset <= at + 2; offset++) {
        const px = Math.round(bx + nx * offset);
        const py = Math.round(by + ny * offset);
        if (px < 1 || py < 1 || px >= small.width - 1 || py >= small.height - 1) continue;
        const value = gradient.data[py * small.width + px];
        if (value > bestEdge) { bestEdge = value; bestAt = offset; }
      }
      found.push({ x: bx + nx * bestAt, y: by + ny * bestAt, weight: Math.max(1, bestEdge) });
    }
    // Keep the fitted line only if it actually lies on more edge than the one
    // it replaces. A side is a real boundary or it is not, and the gradient
    // says which: a line that has drifted onto blank paper, or onto the wrong
    // edge entirely, sits on less of it and is refused here rather than
    // allowed to drag two corners with it.
    const was = lineThrough(scaled[side], scaled[(side + 1) % 4]);
    const fitted = fitLine(found);
    lines.push(
      fitted && supportFor(fitted, scaled[side], scaled[(side + 1) % 4], gradient, small)
        >= supportFor(was, scaled[side], scaled[(side + 1) % 4], gradient, small)
        ? fitted
        : was
    );
  }

  const refined = [];
  for (let corner = 0; corner < 4; corner++) {
    // Corner n is where the side ending at it meets the side leaving it.
    const meeting = intersect(lines[(corner + 3) % 4], lines[corner]);
    if (!meeting) return quad;
    const x = Math.round(meeting[0] * step);
    const y = Math.round(meeting[1] * step);
    const moved = Math.hypot(x - quad[corner][0], y - quad[corner][1]);
    // A refinement that wants to move a corner a long way has found something
    // else, not the page. Keep what we had.
    refined.push(moved > limit ? quad[corner] : [
      Math.max(0, Math.min(image.width - 1, x)),
      Math.max(0, Math.min(image.height - 1, y)),
    ]);
  }
  return refined;
}

// How much real edge a line sits on, over the stretch the side covers.
// Projecting the two ends onto the line keeps the comparison honest: both
// candidates are measured along the same part of the page.
function supportFor(line, from, to, gradient, small) {
  const [a, b, c] = line;
  const project = ([x, y]) => {
    const away = a * x + b * y - c;
    return [x - a * away, y - b * away];
  };
  const [x1, y1] = project(from);
  const [x2, y2] = project(to);
  const steps = Math.max(12, Math.round(Math.hypot(x2 - x1, y2 - y1)));

  let total = 0;
  let counted = 0;
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x1 + ((x2 - x1) * s) / steps);
    const y = Math.round(y1 + ((y2 - y1) * s) / steps);
    if (x < 1 || y < 1 || x >= small.width - 1 || y >= small.height - 1) { counted++; continue; }
    let strongest = 0;
    for (let d = -1; d <= 1; d++) {
      for (let e = -1; e <= 1; e++) {
        const value = gradient.data[(y + d) * small.width + (x + e)];
        if (value > strongest) strongest = value;
      }
    }
    total += strongest;
    counted++;
  }
  return counted ? total / counted : 0;
}

// Divide a grey plane by its own slow-changing brightness, so a sheet lit
// unevenly - or with a hand's shadow across it - reads as one even tone. The
// same closing used to take the shadow off a finished page (see `enhance`).
function flatten(small) {
  const span = Math.max(4, Math.round(Math.max(small.width, small.height) * 0.06));
  const background = boxBlur(closing(small, span), 2);
  const out = new Uint8ClampedArray(small.data.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = (small.data[i] / Math.max(16, background.data[i])) * 200;
  }
  return { data: out, width: small.width, height: small.height };
}

// A line as (a, b, c) with ax + by = c and (a, b) a unit normal, fitted by
// total least squares so a vertical edge is no harder than a horizontal one.
// Run twice, dropping the points that disagree most with the first pass: on a
// page edge those are the ones that caught something else.
function fitLine(points) {
  if (points.length < 6) return null;
  let working = points;
  let line = null;

  for (let pass = 0; pass < 2; pass++) {
    let weight = 0;
    let mx = 0;
    let my = 0;
    for (const p of working) { weight += p.weight; mx += p.x * p.weight; my += p.y * p.weight; }
    if (!weight) return null;
    mx /= weight;
    my /= weight;

    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const p of working) {
      const dx = p.x - mx;
      const dy = p.y - my;
      sxx += p.weight * dx * dx;
      sxy += p.weight * dx * dy;
      syy += p.weight * dy * dy;
    }
    // The smaller eigenvector of the scatter matrix is the normal.
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const a = -Math.sin(theta);
    const b = Math.cos(theta);
    line = [a, b, a * mx + b * my];

    if (pass === 0) {
      const distances = working.map((p) => Math.abs(a * p.x + b * p.y - line[2]));
      const sorted = [...distances].sort((u, v) => u - v);
      const median = sorted[sorted.length >> 1];
      const keep = working.filter((_, i) => distances[i] <= Math.max(1.5, median * 2.5));
      if (keep.length >= 6) working = keep;
    }
  }
  return line;
}

const lineThrough = ([x1, y1], [x2, y2]) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const a = -dy / length;
  const b = dx / length;
  return [a, b, a * x1 + b * y1];
};

function intersect([a1, b1, c1], [a2, b2, c2]) {
  const determinant = a1 * b2 - a2 * b1;
  // Two sides that have ended up parallel meet nowhere useful.
  if (Math.abs(determinant) < 1e-6) return null;
  return [(c1 * b2 - c2 * b1) / determinant, (a1 * c2 - a2 * c1) / determinant];
}

// --- 2. straighten ---------------------------------------------------------

// The 3x3 projective transform taking the unit output rectangle's corners onto
// the four corners found in the photo. Eight unknowns, four point pairs, solved
// directly - this is the whole of "perspective correction".
export function homography(from, to) {
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const solved = solve(rows);
  if (!solved) return null;
  return [solved[0], solved[1], solved[2], solved[3], solved[4], solved[5], solved[6], solved[7], 1];
}

// Gaussian elimination with partial pivoting on an 8x9 system.
function solve(rows) {
  const n = rows.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    if (Math.abs(rows[pivot][col]) < 1e-10) return null;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const lead = rows[col][col];
    for (let c = col; c <= n; c++) rows[col][c] /= lead;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = rows[r][col];
      if (!factor) continue;
      for (let c = col; c <= n; c++) rows[r][c] -= factor * rows[col][c];
    }
  }
  return rows.map((row) => row[n]);
}

// Straighten the page onto a clean rectangle, sampling bilinearly so small
// text survives the move.
export function warpPerspective(image, corners, size) {
  const { width: outW, height: outH } = size;
  const out = { data: new Uint8ClampedArray(outW * outH * 4), width: outW, height: outH };

  // Map output pixels back into the photo, which is what lets every output
  // pixel be filled exactly once.
  const h = homography([[0, 0], [outW - 1, 0], [outW - 1, outH - 1], [0, outH - 1]], corners);
  if (!h) return null;

  const { data, width, height } = image;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const denominator = h[6] * x + h[7] * y + h[8];
      const sx = (h[0] * x + h[1] * y + h[2]) / denominator;
      const sy = (h[3] * x + h[4] * y + h[5]) / denominator;
      const target = (y * outW + x) * 4;

      if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) {
        out.data[target] = out.data[target + 1] = out.data[target + 2] = 255;
        out.data[target + 3] = 255;
        continue;
      }

      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const topLeft = (y0 * width + x0) * 4;
      const topRight = (y0 * width + x1) * 4;
      const bottomLeft = (y1 * width + x0) * 4;
      const bottomRight = (y1 * width + x1) * 4;

      for (let channel = 0; channel < 3; channel++) {
        const top = data[topLeft + channel] * (1 - fx) + data[topRight + channel] * fx;
        const bottom = data[bottomLeft + channel] * (1 - fx) + data[bottomRight + channel] * fx;
        out.data[target + channel] = top * (1 - fy) + bottom * fy;
      }
      out.data[target + 3] = 255;
    }
  }
  return out;
}

// --- 3. take the room off the page -----------------------------------------

// Divide the page by its own slow-changing brightness. This is what removes
// the shadow of a hand or a lamp and makes paper read as white, and it is the
// single step that makes a phone photo look like a scan.
export function removeShadow(image, { radius = 0.08, strength = 1 } = {}) {
  const { data, width, height } = image;
  const gray = luminance(image);
  const small = shrinkGray(gray, 64);
  const blurred = boxBlur(small, Math.max(1, Math.round(Math.max(small.width, small.height) * radius)));

  const out = { data: new Uint8ClampedArray(data.length), width, height };
  const sx = small.width / width;
  const sy = small.height / height;

  for (let y = 0; y < height; y++) {
    const by = Math.min(small.height - 1, (y * sy) | 0);
    for (let x = 0; x < width; x++) {
      const bx = Math.min(small.width - 1, (x * sx) | 0);
      // The background is never allowed near zero, or dark pixels explode.
      const background = Math.max(32, blurred.data[by * small.width + bx]);
      const gain = (255 / background) * strength + (1 - strength);
      const i = (y * width + x) * 4;
      out.data[i] = data[i] * gain;
      out.data[i + 1] = data[i + 1] * gain;
      out.data[i + 2] = data[i + 2] * gain;
      out.data[i + 3] = 255;
    }
  }
  return out;
}

// The brightest value within `radius` of each pixel, done as two passes of a
// one-dimensional maximum, which is what makes it affordable: a square window
// costs the same as a line.
//
// The running maximum keeps a queue of candidates in decreasing order, so each
// pixel enters and leaves once however wide the window is.
export const localMax = (image, radius) => rank(image, radius, true);
export const localMin = (image, radius) => rank(image, radius, false);

// Dilate, then erode by the same amount: the text disappears because it is
// narrower than the window, while the edge of a shadow stays where it is,
// because whatever the dilation pushed outwards the erosion pulls back.
//
// Using the dilation on its own - which is what the first attempt did - makes
// the estimated lighting brighter than the paper everywhere near a shadow, so
// the division under-corrects exactly where the shadow is. Measured on a real
// photograph: shadowed paper reached 147 where lit paper reached 240.
export const closing = (image, radius) => localMin(localMax(image, radius), radius);

function rank({ data, width, height }, radius, wantMax) {
  const horizontal = new Uint8ClampedArray(data.length);
  const out = new Uint8ClampedArray(data.length);
  const queue = new Int32Array(Math.max(width, height));
  const better = wantMax ? (a, b) => a <= b : (a, b) => a >= b;

  const pass = (source, target, length, lines, index) => {
    for (let line = 0; line < lines; line++) {
      let head = 0;
      let tail = 0;
      for (let i = 0; i < length + radius; i++) {
        if (i < length) {
          const value = source[index(line, i)];
          while (tail > head && better(source[index(line, queue[tail - 1])], value)) tail--;
          queue[tail++] = i;
        }
        const at = i - radius;
        if (at >= 0) {
          // Drop anything that has fallen out of the window behind us.
          while (head < tail && queue[head] < at - radius) head++;
          target[index(line, at)] = source[index(line, queue[head])];
        }
      }
    }
  };

  pass(data, horizontal, width, height, (line, i) => line * width + i);
  pass(horizontal, out, height, width, (line, i) => i * width + line);
  return { data: out, width, height };
}

export function boxBlur({ data, width, height }, radius) {
  const horizontal = new Uint8ClampedArray(data.length);
  const out = new Uint8ClampedArray(data.length);
  const window = radius * 2 + 1;

  for (let y = 0; y < height; y++) {
    let total = 0;
    for (let x = -radius; x <= radius; x++) total += data[y * width + clamp(x, width)];
    for (let x = 0; x < width; x++) {
      horizontal[y * width + x] = total / window;
      total += data[y * width + clamp(x + radius + 1, width)] - data[y * width + clamp(x - radius, width)];
    }
  }
  for (let x = 0; x < width; x++) {
    let total = 0;
    for (let y = -radius; y <= radius; y++) total += horizontal[clamp(y, height) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = total / window;
      total += horizontal[clamp(y + radius + 1, height) * width + x] - horizontal[clamp(y - radius, height) * width + x];
    }
  }
  return { data: out, width, height };
}

const clamp = (value, limit) => (value < 0 ? 0 : value > limit - 1 ? limit - 1 : value);

// --- 4. use the whole range ------------------------------------------------

// Stretch between percentiles rather than the darkest and brightest pixels, so
// one speck of dust or one glare spot cannot decide the contrast of the page.
export function autoContrast(image, { low = 0.01, high = 0.995 } = {}) {
  const { data, width, height } = image;
  const histogram = new Uint32Array(256);
  const gray = luminance(image);
  for (const value of gray.data) histogram[value]++;

  const total = gray.data.length;
  let blackPoint = 0;
  let whitePoint = 255;
  let seen = 0;
  for (let i = 0; i < 256; i++) {
    seen += histogram[i];
    if (seen >= total * low) { blackPoint = i; break; }
  }
  seen = 0;
  for (let i = 0; i < 256; i++) {
    seen += histogram[i];
    if (seen >= total * high) { whitePoint = i; break; }
  }
  if (whitePoint - blackPoint < 16) return image;      // nothing to stretch

  const scale = 255 / (whitePoint - blackPoint);
  const out = { data: new Uint8ClampedArray(data.length), width, height };
  for (let i = 0; i < data.length; i += 4) {
    out.data[i] = (data[i] - blackPoint) * scale;
    out.data[i + 1] = (data[i + 1] - blackPoint) * scale;
    out.data[i + 2] = (data[i + 2] - blackPoint) * scale;
    out.data[i + 3] = 255;
  }
  return out;
}

// --- 3 and 4 together ------------------------------------------------------

// Flatten the lighting and set the tone in one pass.
//
// Doing it in two - normalise the paper to white, then stretch the histogram to
// full range - brightens the page twice. The paper ends up blown out and the
// light grey of a pencil or a faded print is pushed into the white with it.
// This is the bug that made the first version come out "too bright".
//
// So: divide by the slow-changing brightness to take the room's shadow off,
// then land the paper a little under white and bend the mid-tones down, which
// is what keeps grey writing grey instead of losing it.
//
//   paper   where clean paper lands. Below 255 on purpose: it leaves the
//           texture of the sheet visible and keeps headroom, which is what
//           stops the page looking bleached.
//   gamma   above 1 darkens the mid-tones - the faint writing that a plain
//           stretch erases.
//   floor   how much of the dark end may be crushed to black, at most.
//   radius  how slowly the lighting is assumed to change. Too small and the
//           writing is read as shadow and eaten.
export function enhance(image, {
  paper = 252,          // where clean paper lands
  paperPoint = 1.04,    // ratio at which a pixel counts as fully paper
  punch = null,         // null = measured (pickPunch); a number forces it
  inkBudget = 0.02,     // at most 2% of the writing may be lost to the curve
  floor = 0.55,
  window = 0.035,
  denoise = true,
  sharpen = 0.6,
  strength = 1,
} = {}) {
  const { data, width, height } = image;

  // The lighting is worked out for each colour separately, which is what takes
  // the colour of the room out along with its shadow: paper under a warm lamp
  // has more red in it than blue, and dividing each channel by its own
  // background lands all three on the same white. Doing it once on brightness
  // and applying the result to all three channels keeps the cast and makes it
  // stronger wherever the correction is largest.
  const planes = [0, 1, 2].map((channel) => {
    const plane = new Uint8ClampedArray(width * height);
    for (let p = 0, i = channel; p < plane.length; p++, i += 4) plane[p] = data[i];
    // Big enough that a hard shadow edge stays an edge: at 96 pixels across,
    // the boundary of a hand's shadow is three pixels wide.
    const small = shrinkGray({ data: plane, width, height }, 384);
    const span = Math.max(4, Math.round(Math.max(small.width, small.height) * window));
    // A light smoothing afterwards, small enough not to drag the shadow's edge
    // about again.
    return { small, background: boxBlur(closing(small, span), 2) };
  });

  const sx = planes[0].small.width / width;
  const sy = planes[0].small.height / height;
  const sampleAt = ({ small, background }, x, y) => {
    const fx = Math.min(small.width - 1, x * sx);
    const fy = Math.min(small.height - 1, y * sy);
    const x0 = fx | 0;
    const y0 = fy | 0;
    const x1 = Math.min(x0 + 1, small.width - 1);
    const y1 = Math.min(y0 + 1, small.height - 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const top = background.data[y0 * small.width + x0] * (1 - ax) + background.data[y0 * small.width + x1] * ax;
    const bottom = background.data[y1 * small.width + x0] * (1 - ax) + background.data[y1 * small.width + x1] * ax;
    return Math.max(16, top * (1 - ay) + bottom * ay);
  };

  // How bright each pixel is next to the lighting around it. Paper comes out
  // near 1 wherever it is on the page, lit or shadowed; ink comes out well
  // below. The percentiles are taken on brightness so that a coloured page
  // does not shift them.
  const BUCKETS = 1024;
  const histogram = new Uint32Array(BUCKETS);
  const ratios = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let luma = 0;
      for (let c = 0; c < 3; c++) {
        const ratio = data[p * 4 + c] / sampleAt(planes[c], x, y);
        ratios[p * 3 + c] = ratio;
        luma += ratio * (c === 0 ? 0.299 : c === 1 ? 0.587 : 0.114);
      }
      histogram[Math.min(BUCKETS - 1, (luma * (BUCKETS / 2)) | 0)]++;
    }
  }
  const at = (fraction) => {
    const wanted = width * height * fraction;
    let seen = 0;
    for (let b = 0; b < BUCKETS; b++) {
      seen += histogram[b];
      if (seen >= wanted) return b / (BUCKETS / 2);
    }
    return 1;
  };

  const paperRatio = Math.max(0.2, at(0.92));
  const inkRatio = at(0.02);
  // Never crush more of the dark end than `floor`, or a page with no real ink
  // on it loses what little it has.
  const low = Math.min(floor, Math.max(0, inkRatio / paperRatio));

  // How hard to pull paper to white and ink to black. Chosen by measurement,
  // not by trust: see pickPunch.
  const chosen = punch === null
    ? pickPunch({ histogram, BUCKETS, paperRatio, low, paperPoint, paper, inkBudget })
    : { punch, lost: null };

  const out = { data: new Uint8ClampedArray(data.length), width, height };
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < 3; c++) {
      const curved = softCurve(ratios[p * 3 + c] / paperRatio, low, paperPoint, chosen.punch);
      const corrected = curved * paper;
      out.data[p * 4 + c] = corrected * strength + data[p * 4 + c] * (1 - strength);
    }
    out.data[p * 4 + 3] = 255;
  }

  out.inkLost = chosen.lost;
  return denoise || sharpen ? finish(out, { denoise, sharpen, paper }) : out;
}

// The tone curve: nothing below `low` survives, nothing above `paperPoint` is
// pushed further, and smoothstep rounds both ends so the corners are soft.
//
// A soft top matters more than it sounds. A hard one turns every mark that is
// a little lighter than the ink - pencil, a faded print, a watermark - into
// paper, and that is the one way arithmetic can lose content. Each extra
// `punch` is another smoothstep: more contrast, and more risk at that end,
// which is why the number is chosen by measurement.
export function softCurve(t, low, paperPoint, punch) {
  let u = (t - low) / (paperPoint - low);
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  for (let i = 0; i < punch; i++) u = u * u * (3 - 2 * u);
  return u;
}

// Pick the strongest curve that does not erase the writing.
//
// The curve depends only on the ratio, and the ratios are already counted in a
// histogram, so how much ink a given setting would lose can be worked out
// exactly - no second pass over the pixels, no guessing. Ink is anything
// clearly darker than paper; it is "lost" when the curve lands it close enough
// to paper to be invisible.
export function pickPunch({ histogram, BUCKETS, paperRatio, low, paperPoint, paper, inkBudget = 0.02 }) {
  const ratioOfBucket = (b) => b / (BUCKETS / 2) / paperRatio;
  const inkCut = (low + 1) / 2;            // halfway between the darkest ink and paper
  const vanished = 245 / paper;            // indistinguishable from paper once drawn

  let ink = 0;
  for (let b = 0; b < BUCKETS; b++) if (ratioOfBucket(b) < inkCut) ink += histogram[b];
  if (ink === 0) return { punch: 1, lost: 0 };

  for (const punch of [3, 2, 1, 0]) {
    let lost = 0;
    for (let b = 0; b < BUCKETS; b++) {
      if (!histogram[b]) continue;
      const t = ratioOfBucket(b);
      if (t >= inkCut) continue;
      if (softCurve(t, low, paperPoint, punch) > vanished) lost += histogram[b];
    }
    if (lost / ink <= inkBudget) return { punch, lost: lost / ink };
  }
  return { punch: 0, lost: 0 };
}

// Flatten the paper and put the edge back on the writing.
//
// Both only make sense after the tone is set: smoothing first would blur text
// into paper, and sharpening first would sharpen the sensor noise.
function finish(image, { denoise, sharpen, paper }) {
  const { width, height } = image;
  const source = image.data;
  const gray = luminance(image).data;
  const out = new Uint8ClampedArray(source.length);
  const paperFloor = paper * 0.78;
  const flat = 14;              // a 3x3 range under this is noise, not an edge

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      out[i + 3] = 255;

      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        out[i] = source[i]; out[i + 1] = source[i + 1]; out[i + 2] = source[i + 2];
        continue;
      }

      let min = 255;
      let max = 0;
      let total = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = gray[p + dy * width + dx];
          if (v < min) min = v;
          if (v > max) max = v;
          total += v;
        }
      }
      const mean = total / 9;

      // Flat and bright: paper. Average it, and the sensor's mottle goes.
      if (denoise && max - min < flat && mean > paperFloor) {
        for (let c = 0; c < 3; c++) {
          let channel = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) channel += source[(p + dy * width + dx) * 4 + c];
          }
          out[i + c] = channel / 9;
        }
        continue;
      }

      // Everything else is writing or an edge: give back the crispness that
      // resizing and resampling cost it.
      const edge = sharpen ? (gray[p] - mean) * sharpen : 0;
      for (let c = 0; c < 3; c++) out[i + c] = source[i + c] + edge;
    }
  }
  return { data: out, width, height, inkLost: image.inkLost };
}

// Wipe out what is not the page but got into the frame.
//
// A corner a little outside the sheet brings a sliver of desk, or of the sheet
// underneath, into the straightened rectangle. It arrives as dark patches at
// the edges and reads as a dirty border. Trimming whole rows cannot remove
// them, because they are patches rather than bands, and cutting enough rows to
// catch them would eat the page.
//
// What separates them from the document is simple: they touch the border, and
// writing does not. So anything dark that can be reached from the edge is
// flooded out to paper, and anything dark that cannot - every letter on the
// page - is left exactly as it was.
//
// Two guards. The fill is abandoned if it grows past a share of the page,
// which is what would happen on a dark page or a photograph that reaches the
// edge; and a page whose own content runs into the border keeps it.
export function clearBorderStains(image, { paper = 252, maxShare = 0.12 } = {}) {
  const { data, width, height } = image;
  const gray = luminance(image);
  const notPaper = paper * 0.78;

  // Each patch is judged on its own, not all of them together: one big dark
  // area must not stop a small stain elsewhere being cleared, and a patch that
  // reaches well into the page is something the page is made of rather than
  // something that leaked in at the side.
  const maxDepth = Math.round(Math.min(width, height) * 0.1);
  const maxPixels = width * height * maxShare;

  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const cleared = [];

  const start = (seed) => {
    if (seen[seed] || gray.data[seed] >= notPaper) return;
    let head = 0;
    let tail = 0;
    seen[seed] = 1;
    queue[tail++] = seed;
    let deepest = 0;
    let runaway = false;

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = (index - x) / width;
      const depth = Math.min(x, y, width - 1 - x, height - 1 - y);
      if (depth > deepest) deepest = depth;
      if (deepest > maxDepth || tail > maxPixels) { runaway = true; break; }

      const consider = (next) => {
        if (!seen[next] && gray.data[next] < notPaper) { seen[next] = 1; queue[tail++] = next; }
      };
      if (x > 0) consider(index - 1);
      if (x < width - 1) consider(index + 1);
      if (y > 0) consider(index - width);
      if (y < height - 1) consider(index + width);
    }
    // Everything reached stays marked either way, so a patch that was refused
    // is not walked again from another point on the border.
    if (!runaway) for (let i = 0; i < tail; i++) cleared.push(queue[i]);
  };

  for (let x = 0; x < width; x++) {
    start(x);
    start((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    start(y * width);
    start(y * width + width - 1);
  }
  if (!cleared.length) return image;

  const out = { data: new Uint8ClampedArray(data), width, height, inkLost: image.inkLost };
  for (const index of cleared) {
    const at = index * 4;
    out.data[at] = paper;
    out.data[at + 1] = paper;
    out.data[at + 2] = paper;
    out.data[at + 3] = 255;
  }
  return out;
}

// Cut off a rim of whatever is not the page.
//
// A corner a little outside the sheet drags a sliver of desk, or of the sheet
// underneath, along the edge of the straightened page, and it reads as a dirty
// border. Finding the sheet's edge exactly is not always possible - a page
// lying on more white paper barely has a visible one - but a dark rim on the
// finished rectangle is obvious, and removing it needs no cleverness.
//
// Bounded hard, and judged on the flattened image: an unbounded trim would eat
// the page, and a shadow across the real page would otherwise look like border.
export function trimBorders(image, { maxFraction = 0.035 } = {}) {
  const small = shrinkGray(luminance(image), 600);
  const flat = flatten(small);
  const { width, height } = small;

  const middle = [];
  for (let y = Math.round(height * 0.3); y < height * 0.7; y++) {
    for (let x = Math.round(width * 0.3); x < width * 0.7; x += 2) middle.push(flat.data[y * width + x]);
  }
  if (middle.length < 50) return image;
  middle.sort((a, b) => a - b);
  const pageLevel = middle[middle.length >> 1];
  const spread = middle[Math.floor(middle.length * 0.84)] - middle[Math.floor(middle.length * 0.16)];
  const off = pageLevel - Math.max(18, spread * 1.6);

  // A line counts as border when much of it is not page.
  const lineIsBorder = (get, length) => {
    let bad = 0;
    let seen = 0;
    for (let i = Math.round(length * 0.08); i < length * 0.92; i += 2) {
      if (get(i) < off) bad++;
      seen++;
    }
    return seen > 0 && bad / seen > 0.35;
  };

  const limitY = Math.round(height * maxFraction);
  const limitX = Math.round(width * maxFraction);
  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  while (top < limitY && lineIsBorder((x) => flat.data[top * width + x], width)) top++;
  while (bottom < limitY && lineIsBorder((x) => flat.data[(height - 1 - bottom) * width + x], width)) bottom++;
  while (left < limitX && lineIsBorder((y) => flat.data[y * width + left], height)) left++;
  while (right < limitX && lineIsBorder((y) => flat.data[y * width + (width - 1 - right)], height)) right++;
  if (!(top || bottom || left || right)) return image;

  // Back to the straightened page's own pixels, with a pixel to spare.
  const sx = image.width / width;
  const sy = image.height / height;
  const x0 = Math.min(image.width - 8, Math.round(left * sx) + 1);
  const y0 = Math.min(image.height - 8, Math.round(top * sy) + 1);
  const x1 = Math.max(x0 + 8, image.width - Math.round(right * sx) - 1);
  const y1 = Math.max(y0 + 8, image.height - Math.round(bottom * sy) - 1);

  const out = { data: new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4), width: x1 - x0, height: y1 - y0 };
  for (let y = y0; y < y1; y++) {
    const from = (y * image.width + x0) * 4;
    out.data.set(image.data.subarray(from, from + (x1 - x0) * 4), (y - y0) * (x1 - x0) * 4);
  }
  return out;
}

// --- the whole job ---------------------------------------------------------

// corners: pass what detectPage found, or what the person dragged to. Pass
// null and the whole frame is used.
// How bright the finished page should be. "normal" is the default; the other
// two exist because the right answer depends on the paper and the light, and
// the person holding the phone can see which it is.
// How bright the finished page should be. "normal" is the default; the others
// exist because the right answer depends on the paper and the light, and the
// person holding the phone can see which it is.
//
// "text" is for a page that is only writing - it pulls almost to black on
// white, which is what a photocopier does and what people picture when they
// say "a scan". It is the strongest setting, so the ink guard matters most
// there; a page with a photograph on it should use one of the others.
export const TONES = {
  soft:   { paper: 244, paperPoint: 1.10, sharpen: 0.4 },
  normal: { paper: 252, paperPoint: 1.04, sharpen: 0.6 },
  bright: { paper: 255, paperPoint: 0.99, sharpen: 0.7 },
  text:   { paper: 255, paperPoint: 0.96, sharpen: 0.9, inkBudget: 0.015 },
};

export function cleanPage(image, corners = null, { maxEdge = MAX_LONG_EDGE, tone = 'normal' } = {}) {
  // With no corners there is nothing to straighten, so the warp is skipped
  // rather than run on the whole frame: it would resample every pixel for no
  // gain and cost the image a little sharpness. The caller caps the size.
  const straightened = corners
    ? warpPerspective(image, corners, outputSize(corners, maxEdge)) ?? image
    : image;
  // Only when the corners were given: with no crop there is no rim to cut.
  const trimmed = corners ? trimBorders(straightened) : straightened;
  const settings = TONES[tone] ?? TONES.normal;
  const cleaned = enhance(trimmed, settings);
  // Only when the page was cropped: an uncropped frame has no border to clear,
  // and whatever is at its edge is the picture itself.
  return corners ? clearBorderStains(cleaned, { paper: settings.paper }) : cleaned;
}
