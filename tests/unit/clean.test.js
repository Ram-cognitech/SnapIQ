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
  autoContrast, detectPage, enhance, homography, luminance, otsu, outputSize, TONES,
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
