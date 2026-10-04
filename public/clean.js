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
export function detectPage(image, { minAreaFraction = 0.15 } = {}) {
  const full = luminance(image);
  const small = shrinkGray(full, 320);
  const { data, width, height } = small;
  const step = small.step ?? 1;

  const threshold = otsu(small);
  if (threshold < 0) return null;          // one flat tone: there is no page here
  // The page is the brighter group. Anything at or below the threshold is the
  // world around it.
  const bright = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) bright[i] = data[i] > threshold ? 1 : 0;

  const component = largestComponent(bright, width, height);
  if (!component) return null;
  if (component.size < width * height * minAreaFraction) return null;

  // Corners by extremes of the two diagonals: the top-left of a quadrilateral
  // is its smallest x+y, the top-right its largest x-y, and so on. Cheap, and
  // steady as long as the page is not rotated past 45 degrees - which nobody
  // does when photographing a document.
  let tl = null, tr = null, br = null, bl = null;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (const index of component.pixels) {
    const x = index % width;
    const y = (index - x) / width;
    const sum = x + y;
    const diff = x - y;
    if (sum < minSum) { minSum = sum; tl = [x, y]; }
    if (sum > maxSum) { maxSum = sum; br = [x, y]; }
    if (diff > maxDiff) { maxDiff = diff; tr = [x, y]; }
    if (diff < minDiff) { minDiff = diff; bl = [x, y]; }
  }
  if (!tl || !tr || !br || !bl) return null;

  // Back to the photograph's own coordinates, and nudged to the middle of the
  // block each shrunken pixel stood for.
  const back = ([x, y]) => [
    Math.min(image.width - 1, Math.round((x + 0.5) * step)),
    Math.min(image.height - 1, Math.round((y + 0.5) * step)),
  ];
  const corners = [back(tl), back(tr), back(br), back(bl)];

  // A quadrilateral that is nearly the whole frame means no page was found,
  // only the photo's own edges; and a sliver means something went wrong.
  const area = polygonArea(corners);
  if (area < image.width * image.height * minAreaFraction) return null;
  return corners;
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

// --- the whole job ---------------------------------------------------------

// corners: pass what detectPage found, or what the person dragged to. Pass
// null and the whole frame is used.
export function cleanPage(image, corners = null, { maxEdge = MAX_LONG_EDGE } = {}) {
  // With no corners there is nothing to straighten, so the warp is skipped
  // rather than run on the whole frame: it would resample every pixel for no
  // gain and cost the image a little sharpness. The caller caps the size.
  const straightened = corners
    ? warpPerspective(image, corners, outputSize(corners, maxEdge)) ?? image
    : image;
  return autoContrast(removeShadow(straightened));
}
