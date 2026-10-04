// The PDF writer. A malformed PDF is the kind of thing that looks fine until
// someone opens it in a different reader, so the structure is checked rather
// than assumed: the offsets in the cross-reference table must actually point
// at the objects they claim.

import { describe, expect, it } from 'vitest';
import { buildPdf } from '../../public/pdf.js';

const text = (bytes) => new TextDecoder('latin1').decode(bytes);

// Not a real photograph, but the bytes a reader looks for: a JPEG opens with
// FFD8 and ends with FFD9.
const jpeg = (marker = 0x41) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, marker, marker, marker, 0xff, 0xd9]);

describe('building a PDF', () => {
  it('writes a file a reader will recognise', () => {
    const pdf = buildPdf([{ jpeg: jpeg(), width: 2480, height: 3508 }]);
    const body = text(pdf);
    expect(body.startsWith('%PDF-1.4')).toBe(true);
    expect(body.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(body).toContain('/Type /Catalog');
    expect(body).toContain('/Type /Pages');
    expect(body).toContain('/Filter /DCTDecode');
  });

  it('puts every page in, in order', () => {
    const pdf = buildPdf([
      { jpeg: jpeg(0x41), width: 1000, height: 1400 },
      { jpeg: jpeg(0x42), width: 1000, height: 1400 },
      { jpeg: jpeg(0x43), width: 1000, height: 1400 },
    ]);
    const body = text(pdf);
    expect(body).toContain('/Count 3');
    expect(body).toContain('/Kids [3 0 R 6 0 R 9 0 R]');
    expect((body.match(/\/Type \/Page[^s]/g) ?? []).length).toBe(3);
    // Each page's own bytes are in there, once.
    for (const marker of [0x41, 0x42, 0x43]) {
      const needle = text(jpeg(marker));
      expect(body.split(needle).length - 1, `page ${marker}`).toBe(1);
    }
  });

  it('sizes an A4 scan as A4, so it prints at the right size', () => {
    // 2480 x 3508 at 300 dots per inch is A4.
    const pdf = buildPdf([{ jpeg: jpeg(), width: 2480, height: 3508 }]);
    expect(text(pdf)).toContain('/MediaBox [0 0 595.2 841.92]');
  });

  it('keeps the camera bytes exactly as they were', () => {
    // Nothing is re-encoded: a page already compressed once must not be
    // compressed again on the way into the document.
    const original = jpeg(0x7a);
    const pdf = buildPdf([{ jpeg: original, width: 100, height: 100 }]);
    const haystack = text(pdf);
    const at = haystack.indexOf(text(original));
    expect(at).toBeGreaterThan(0);
    expect(pdf.slice(at, at + original.length)).toEqual(original);
  });

  it('writes a cross-reference table that points at the real objects', () => {
    const pdf = buildPdf([
      { jpeg: jpeg(0x41), width: 800, height: 1000 },
      { jpeg: jpeg(0x42), width: 800, height: 1000 },
    ]);
    const body = text(pdf);

    // startxref must point at the table.
    const startxref = Number(body.match(/startxref\s+(\d+)/)[1]);
    expect(body.slice(startxref, startxref + 4)).toBe('xref');

    // And every entry must land on "<n> 0 obj".
    const table = body.slice(startxref).match(/(\d{10}) 00000 n/g) ?? [];
    expect(table.length).toBe(8);          // 2 + 2 pages x 3
    table.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(body.slice(offset, offset + 20)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  it('refuses to write a document with no pages', () => {
    expect(() => buildPdf([])).toThrow(/at least one page/);
  });
});
