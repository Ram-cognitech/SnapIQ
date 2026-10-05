// The image pipeline, tested numerically.
//
// These are the steps nobody can check by reading them: whether the page is
// actually found, whether straightening puts the corners where they belong,
// whether a shadow is removed. So the tests build photographs with known
// answers and assert on the numbers.
//
// No browser and no server needed - clean.js is plain functions over
// {data, width, height}.

import { describe, expect, it } from 'vitest';
import {
  autoContrast, closing, detectPage, enhance, homography, localMax, luminance, otsu, outputSize,
  pickPunch, refineCorners, softCurve, TONES,
  polygonArea, removeShadow, warpPerspective, cleanPage,
} from '../../public/clean.js';

// A photograph: dark surroundings with a bright quadrilateral on it, the way a
// page on a desk looks to a camera.
function photo(width, height, quad, { page = 235, around = 40, shadow = 0 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = pointInQuad(x, y, quad);
      // A lamp to one side: brightness falls off across the frame.
      const fall = shadow ? 1 - shadow * (x / width) : 1;
      const value = (inside ? page : around) * fall;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

function pointInQuad(x, y, [a, b, c, d]) {
  const side = (p, q) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const signs = [side(a, b), side(b, c), side(c, d), side(d, a)];
  return signs.every((s) => s >= 0) || signs.every((s) => s <= 0);
}

const near = (found, expected, tolerance) => {
  expect(Math.abs(found[0] - expected[0]), `x: ${found} vs ${expected}`).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(found[1] - expected[1]), `y: ${found} vs ${expected}`).toBeLessThanOrEqual(tolerance);
};

describe('finding the page in the photograph', () => {
  it('finds a straight page and returns its corners clockwise from top-left', () => {
    const quad = [[60, 50], [340, 50], [340, 460], [60, 460]];
    const corners = detectPage(photo(400, 520, quad));
    expect(corners).not.toBeNull();
    // Within a few pixels: the search runs on a shrunken copy, so the answer
    // is accurate to about one block of it.
    for (let i = 0; i < 4; i++) near(corners[i], quad[i], 8);
  });

  it('finds a page held at an angle', () => {
    const quad = [[90, 40], [360, 90], [320, 470], [50, 420]];
    const corners = detectPage(photo(420, 520, quad));
    expect(corners).not.toBeNull();
    for (let i = 0; i < 4; i++) near(corners[i], quad[i], 12);
  });

  it('gives up rather than guessing when there is no page', () => {
    // An even grey field: nothing page-shaped in it at all.
    const flat = { data: new Uint8ClampedArray(300 * 300 * 4).fill(128), width: 300, height: 300 };
    expect(detectPage(flat)).toBeNull();
  });

  it('gives up when the bright thing is too small to be the page', () => {
    const speck = [[10, 10], [40, 10], [40, 40], [10, 40]];
    expect(detectPage(photo(400, 400, speck))).toBeNull();
  });

  it('splits a page from its background at a sensible brightness', () => {
    const quad = [[50, 50], [250, 50], [250, 250], [50, 250]];
    const gray = luminance(photo(300, 300, quad, { page: 230, around: 30 }));
    const threshold = otsu(gray);
    expect(threshold).toBeGreaterThan(40);
    expect(threshold).toBeLessThan(220);
  });
});

describe('straightening', () => {
  it('maps the four corners onto the four corners of the output', () => {
    const quad = [[90, 40], [360, 90], [320, 470], [50, 420]];
    const size = { width: 200, height: 300 };
    const h = homography([[0, 0], [199, 0], [199, 299], [0, 299]], quad);
    expect(h).not.toBeNull();

    const apply = ([x, y]) => {
      const d = h[6] * x + h[7] * y + h[8];
      return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
    };
    near(apply([0, 0]), quad[0], 0.001);
    near(apply([199, 0]), quad[1], 0.001);
    near(apply([199, 299]), quad[2], 0.001);
    near(apply([0, 299]), quad[3], 0.001);
  });

  it('turns a slanted page into a rectangle of page, edge to edge', () => {
    const quad = [[80, 30], [330, 80], [300, 450], [40, 400]];
    const image = photo(400, 500, quad);
    const corners = detectPage(image);
    const straightened = warpPerspective(image, corners, outputSize(corners, 400));
    expect(straightened).not.toBeNull();

    // Every corner of the result should now be paper, not desk.
    const at = (x, y) => straightened.data[(y * straightened.width + x) * 4];
    const inset = 4;
    for (const [x, y] of [
      [inset, inset],
      [straightened.width - 1 - inset, inset],
      [straightened.width - 1 - inset, straightened.height - 1 - inset],
      [inset, straightened.height - 1 - inset],
    ]) {
      expect(at(x, y), `corner ${x},${y} should be paper`).toBeGreaterThan(150);
    }
  });

  it('keeps the shape of the page rather than squashing it', () => {
    // Twice as tall as it is wide, and the output should be too.
    const quad = [[100, 50], [200, 50], [200, 250], [100, 250]];
    const size = outputSize(quad);
    expect(size.height / size.width).toBeCloseTo(2, 1);
  });

  it('never exceeds the resolution a document can use', () => {
    const huge = [[0, 0], [8000, 0], [8000, 6000], [0, 6000]];
    const size = outputSize(huge);
    expect(Math.max(size.width, size.height)).toBe(3500);
    // And the shape survives the capping.
    expect(size.width / size.height).toBeCloseTo(8000 / 6000, 1);
  });
});

describe('taking the room off the page', () => {
  it('evens out a page lit from one side', () => {
    const quad = [[20, 20], [280, 20], [280, 380], [20, 380]];
    // A strong falloff: the right-hand edge is at 45% of the left.
    const lit = photo(300, 400, quad, { page: 240, around: 240, shadow: 0.55 });

    const before = luminance(lit);
    const leftBefore = before.data[200 * 300 + 30];
    const rightBefore = before.data[200 * 300 + 270];
    expect(leftBefore - rightBefore).toBeGreaterThan(60);

    const after = luminance(removeShadow(lit));
    const leftAfter = after.data[200 * 300 + 30];
    const rightAfter = after.data[200 * 300 + 270];
    // What was a wide gradient should now be nearly flat.
    expect(Math.abs(leftAfter - rightAfter)).toBeLessThan(20);
  });

  it('leaves the writing dark while making the paper white', () => {
    const width = 200;
    const height = 200;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Grey paper with darker lines of text on it, and a gradient over both.
        const text = y % 20 < 3;
        const value = (text ? 90 : 200) * (1 - 0.4 * (x / width));
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = value;
        data[i + 3] = 255;
      }
    }
    const cleaned = autoContrast(removeShadow({ data, width, height }));
    const gray = luminance(cleaned);
    const paper = gray.data[10 * width + 100];      // y=10 is not a text row
    const ink = gray.data[1 * width + 100];         // y=1 is
    expect(paper).toBeGreaterThan(200);
    expect(ink).toBeLessThan(140);
    expect(paper - ink).toBeGreaterThan(70);
  });
});

describe('the whole job', () => {
  it('turns a photograph of a slanted, badly lit page into a clean rectangle', () => {
    const quad = [[70, 40], [340, 90], [310, 460], [40, 410]];
    const image = photo(400, 500, quad, { page: 225, around: 35, shadow: 0.45 });
    const corners = detectPage(image);
    const cleaned = cleanPage(image, corners, { maxEdge: 600 });

    expect(cleaned.width).toBeGreaterThan(100);
    expect(cleaned.height).toBeGreaterThan(100);
    const gray = luminance(cleaned);
    const middle = gray.data[((cleaned.height >> 1) * cleaned.width) + (cleaned.width >> 1)];
    expect(middle).toBeGreaterThan(200);
  });

  it('still produces something when no page could be found', () => {
    const flat = { data: new Uint8ClampedArray(120 * 160 * 4).fill(128), width: 120, height: 160 };
    const cleaned = cleanPage(flat, detectPage(flat));
    expect(cleaned.width).toBe(120);
    expect(cleaned.height).toBe(160);
  });

  it('measures a quadrilateral the same way round or reversed', () => {
    const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(polygonArea(square)).toBe(100);
    expect(polygonArea([...square].reverse())).toBe(100);
  });
});

describe('setting the tone in one pass', () => {
  // A page with faint grey writing on it, lit from one side: the two cases that
  // the old two-step version got wrong, which is why these exist.
  const faintPage = (width = 240, height = 320, { ink = 150, paper = 205, falloff = 0.5 } = {}) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const writing = y % 24 < 4 && x > width * 0.1 && x < width * 0.9;
        const value = (writing ? ink : paper) * (1 - falloff * (x / width));
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = value;
        data[i + 3] = 255;
      }
    }
    return { data, width, height };
  };

  it('lands clean paper under white, instead of bleaching it', () => {
    const page = enhance(faintPage());
    const gray = luminance(page);
    // y = 12 is between two lines of writing, so it is paper.
    const left = gray.data[12 * page.width + 30];
    const right = gray.data[12 * page.width + 210];
    for (const value of [left, right]) {
      expect(value).toBeGreaterThan(215);
      // The old version pushed this to 255 on both sides and took the faint
      // writing with it.
      expect(value).toBeLessThanOrEqual(252);
    }
  });

  it('evens out the lighting across the page', () => {
    const page = enhance(faintPage());
    const gray = luminance(page);
    const left = gray.data[12 * page.width + 30];
    const right = gray.data[12 * page.width + 210];
    expect(Math.abs(left - right)).toBeLessThan(14);
  });

  it('keeps faint writing visible rather than washing it out', () => {
    const page = enhance(faintPage());
    const gray = luminance(page);
    const paperAt = (x) => gray.data[12 * page.width + x];
    const inkAt = (x) => gray.data[1 * page.width + x];
    // Dark enough to read, on the dim side of the page as well as the bright.
    for (const x of [30, 120, 210]) {
      expect(inkAt(x), `ink at ${x}`).toBeLessThan(200);
      expect(paperAt(x) - inkAt(x), `contrast at ${x}`).toBeGreaterThan(30);
    }
  });

  it('is brighter or softer on request, and ordered the way the names say', () => {
    const middle = (tone) => {
      const page = enhance(faintPage(), TONES[tone]);
      return luminance(page).data[12 * page.width + 120];
    };
    expect(middle('soft')).toBeLessThan(middle('normal'));
    expect(middle('normal')).toBeLessThan(middle('bright'));
  });

  it('does not eat the writing by mistaking it for shadow', () => {
    // A radius so small that the blur follows the lines of text would flatten
    // them away. The default must be well clear of that.
    const page = enhance(faintPage(), { radius: 0.12 });
    const gray = luminance(page);
    const rows = [];
    for (let y = 0; y < 48; y++) rows.push(gray.data[y * page.width + 120]);
    // There should still be a clear swing between the lines and the gaps.
    expect(Math.max(...rows) - Math.min(...rows)).toBeGreaterThan(30);
  });
});

describe('a hard shadow across the page', () => {
  // The failure a real photograph found: a hand's shadow with a sharp edge,
  // covering part of a written page. Estimating the lighting with a blur
  // cannot represent an edge, and estimating it with a dilation alone reads
  // brighter than the paper near one - measured on the real photo, shadowed
  // paper reached 147 where lit paper reached 240.
  const shadowedPage = (width = 300, height = 400, { cut = 0.55, dark = 0.42 } = {}) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const writing = y % 22 < 4 && x > width * 0.08 && x < width * 0.92;
        // A hard edge, slanted, like something held above the page.
        const inShadow = x > width * cut + (y - height / 2) * 0.25;
        const value = (writing ? 70 : 215) * (inShadow ? dark : 1);
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = value;
        data[i + 3] = 255;
      }
    }
    return { data, width, height };
  };

  it('lands lit and shadowed paper at the same brightness', () => {
    const page = enhance(shadowedPage());
    const gray = luminance(page);
    const paperAt = (x) => gray.data[11 * page.width + x];   // y=11 is between lines
    const lit = paperAt(40);
    const shadowed = paperAt(260);
    expect(lit).toBeGreaterThan(215);
    expect(shadowed).toBeGreaterThan(215);
    // The whole point: the two sides of the edge must match.
    expect(Math.abs(lit - shadowed)).toBeLessThan(16);
  });

  it('keeps the writing readable on both sides of the edge', () => {
    const page = enhance(shadowedPage());
    const gray = luminance(page);
    for (const x of [40, 260]) {
      const ink = gray.data[1 * page.width + x];
      const paper = gray.data[11 * page.width + x];
      expect(paper - ink, `contrast at ${x}`).toBeGreaterThan(50);
    }
  });

  it('takes the colour of the room out along with its shadow', () => {
    // Paper under a warm lamp: more red than blue, and more so where it is lit.
    const base = shadowedPage();
    for (let i = 0; i < base.data.length; i += 4) {
      base.data[i] = Math.min(255, base.data[i] * 1.12);        // red up
      base.data[i + 2] = base.data[i + 2] * 0.88;               // blue down
    }
    const page = enhance(base);
    const redMinusBlue = (x) => {
      const i = (11 * page.width + x) * 4;
      return page.data[i] - page.data[i + 2];
    };
    expect(Math.abs(redMinusBlue(40))).toBeLessThan(12);
    expect(Math.abs(redMinusBlue(260))).toBeLessThan(12);
  });

  it('closing leaves a hard edge where it is, unlike a dilation', () => {
    const width = 120;
    const height = 8;
    const plane = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) plane[y * width + x] = x < 60 ? 220 : 90;
    }
    const image = { data: plane, width, height };
    const dilated = localMax(image, 6);
    const closed = closing(image, 6);
    const at = (img, x) => img.data[4 * width + x];

    // A dilation drags the bright side six pixels into the dark one.
    expect(at(dilated, 64)).toBe(220);
    // The closing puts it back.
    expect(at(closed, 64)).toBe(90);
    expect(at(closed, 56)).toBe(220);
  });
});

describe('the curve, and the guard that stops it erasing anything', () => {
  it('rounds both ends and never leaves the range', () => {
    for (const punch of [0, 1, 2, 3]) {
      expect(softCurve(0.2, 0.3, 1, punch)).toBe(0);        // below the ink point
      expect(softCurve(1.5, 0.3, 1, punch)).toBe(1);        // above the paper point
      let previous = -1;
      for (let t = 0; t <= 1.2; t += 0.02) {
        const value = softCurve(t, 0.3, 1, punch);
        expect(value).toBeGreaterThanOrEqual(previous);      // never goes backwards
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
        previous = value;
      }
    }
  });

  it('backs the curve off when faint writing would be lost', () => {
    // A histogram standing for a page whose writing is only a little darker
    // than its paper - a pencil, or a faded print.
    const BUCKETS = 1024;
    const histogram = new Uint32Array(BUCKETS);
    const put = (ratio, count) => { histogram[Math.round(ratio * (BUCKETS / 2))] += count; };
    put(1.0, 50_000);      // paper
    put(0.78, 4_000);      // faint writing, just under the ink cut

    const faint = pickPunch({ histogram, BUCKETS, paperRatio: 1, low: 0.3, paperPoint: 0.96, paper: 255 });
    expect(faint.lost).toBeLessThanOrEqual(0.02);

    // The same page with solid black writing can take the strongest curve.
    const solid = new Uint32Array(BUCKETS);
    solid[Math.round(1.0 * (BUCKETS / 2))] = 50_000;
    solid[Math.round(0.25 * (BUCKETS / 2))] = 4_000;
    const dark = pickPunch({ histogram: solid, BUCKETS, paperRatio: 1, low: 0.2, paperPoint: 0.96, paper: 255 });
    expect(dark.punch).toBeGreaterThanOrEqual(faint.punch);
    expect(dark.lost).toBe(0);
  });

  it('reports how much it lost, so the number can be shown rather than trusted', () => {
    const width = 220;
    const height = 260;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const writing = y % 18 < 3;
        const value = writing ? 120 : 205;
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = value;
        data[i + 3] = 255;
      }
    }
    const page = enhance({ data, width, height });
    expect(typeof page.inkLost).toBe('number');
    expect(page.inkLost).toBeLessThanOrEqual(0.02);
  });

  it('keeps pencil-grey writing after the strongest tone, not just black ink', () => {
    const width = 240;
    const height = 300;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // 150 on 210 paper: the sort of mark a hard pencil leaves.
        const writing = y % 20 < 3 && x > 20 && x < width - 20;
        const value = writing ? 150 : 210;
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = value;
        data[i + 3] = 255;
      }
    }
    const page = enhance({ data, width, height }, TONES.text);
    const gray = luminance(page);
    const paper = gray.data[10 * width + 120];
    const pencil = gray.data[1 * width + 120];
    expect(paper).toBeGreaterThan(235);
    // Still clearly there: the guard exists to stop this becoming paper.
    expect(pencil).toBeLessThan(215);
    expect(paper - pencil).toBeGreaterThan(25);
  });
});

describe('flattening the paper without touching the writing', () => {
  const mottled = (width = 200, height = 200) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const writing = y % 24 < 4 && x > 30 && x < width - 30;
        // Paper with a few levels of sensor mottle on it.
        const noise = ((x * 7 + y * 13) % 5) - 2;
        const value = writing ? 60 : 208 + noise;
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = value;
        data[i + 3] = 255;
      }
    }
    return { data, width, height };
  };

  const spread = (image, y, from, to) => {
    const gray = luminance(image);
    let min = 255;
    let max = 0;
    for (let x = from; x < to; x++) {
      const v = gray.data[y * image.width + x];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min;
  };

  it('takes the mottle out of the paper', () => {
    const page = mottled();
    const before = spread(page, 12, 60, 140);
    const after = spread(enhance(page), 12, 60, 140);
    expect(before).toBeGreaterThan(2);
    expect(after).toBeLessThanOrEqual(before);
  });

  it('leaves the edge of the writing sharp rather than smoothing it away', () => {
    const page = enhance(mottled());
    const gray = luminance(page);
    // Down a column, crossing from paper into a line of writing.
    const paper = gray.data[22 * page.width + 100];
    const ink = gray.data[1 * page.width + 100];
    expect(paper - ink).toBeGreaterThan(120);
  });

  it('can be switched off', () => {
    const page = mottled();
    const plain = enhance(page, { denoise: false, sharpen: 0 });
    expect(plain.width).toBe(page.width);
    expect(plain.height).toBe(page.height);
  });
});

describe('putting roughly-right corners onto the page', () => {
  // A bright sheet on a dark surface, photographed square.
  const sheet = (width = 400, height = 520, inset = 40) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const onPage = x >= inset && x < width - inset && y >= inset && y < height - inset;
        const writing = onPage && y % 30 < 3 && x > inset + 20 && x < width - inset - 20;
        const value = onPage ? (writing ? 70 : 225) : 35;
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = value;
        data[i + 3] = 255;
      }
    }
    return { data, width, height, truth: [[inset, inset], [width - 1 - inset, inset], [width - 1 - inset, height - 1 - inset], [inset, height - 1 - inset]] };
  };

  const away = (quad, truth) =>
    quad.reduce((total, c, i) => total + Math.hypot(c[0] - truth[i][0], c[1] - truth[i][1]), 0) / 4;

  it('pulls corners that are off back onto the edges', () => {
    const page = sheet();
    const off = page.truth.map(([x, y], i) => [x + [5, -6, -4, 6][i], y + [6, 5, -5, -6][i]]);
    const before = away(off, page.truth);
    const after = away(refineCorners(page, off), page.truth);
    expect(before).toBeGreaterThan(5);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(3);
  });

  it('leaves corners alone when they are already right', () => {
    const page = sheet();
    expect(away(refineCorners(page, page.truth), page.truth)).toBeLessThan(5);
  });

  it('leaves a corner alone when the edge is further off than it looks for', () => {
    // The search only reaches so far. Beyond that the honest answer is to keep
    // what it was given rather than to fit whatever happens to be in range.
    const page = sheet();
    const farOff = page.truth.map(([x, y]) => [x + 40, y + 40]);
    const refined = refineCorners(page, farOff, { reach: 0.01 });
    expect(away(refined, page.truth)).toBeGreaterThan(20);
  });

  it('refuses a correction that wants to move a corner a long way', () => {
    // Nothing page-like near this quad: the answer must be the quad itself
    // rather than whatever the search wandered onto.
    const page = sheet();
    const nonsense = [[5, 5], [60, 5], [60, 60], [5, 60]];
    expect(refineCorners(page, nonsense)).toEqual(nonsense);
  });

  it('stops at the edge of the sheet, not at a stronger edge beyond it', () => {
    // A dark band outside the page, stronger than the page's own boundary -
    // the case that walked the corners of a bound notebook onto the stack
    // of pages below it.
    const width = 400;
    const height = 520;
    const inset = 60;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const onPage = x >= inset && x < width - inset && y >= inset && y < height - inset;
        const band = !onPage && x >= inset - 25 && x < width - inset + 25 && y >= inset - 25 && y < height - inset + 25;
        const value = onPage ? 220 : band ? 120 : 0;    // page, grey rim, then black
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = value;
        data[i + 3] = 255;
      }
    }
    const truth = [[inset, inset], [width - 1 - inset, inset], [width - 1 - inset, height - 1 - inset], [inset, height - 1 - inset]];
    const off = truth.map(([x, y], i) => [x + [6, -6, -6, 6][i], y + [6, 6, -6, -6][i]]);
    const refined = refineCorners({ data, width, height }, off);
    // Within a few pixels of the page, not 25 out on the rim's outer edge.
    expect(away(refined, truth)).toBeLessThan(8);
  });
});
