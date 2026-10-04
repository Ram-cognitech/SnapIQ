// Several JPEG pages into one PDF, in the browser.
//
// Written by hand rather than with a library, because the job is narrow: a PDF
// holds JPEG data natively (the DCTDecode filter), so each page is the camera's
// own bytes dropped in whole. Nothing is re-encoded, which means no second
// generation of compression on text that was already compressed once, and no
// megabyte of dependency shipped to a phone to achieve it.
//
// The page is sized at 300 DPI, so a scan of A4 comes out as A4: 2480 x 3508
// pixels becomes 595 x 842 points, which is what a printer expects.

const DPI = 300;
const POINTS_PER_INCH = 72;
const SCALE = POINTS_PER_INCH / DPI;

const latin1 = (text) => {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
};

// pages: [{ jpeg: Uint8Array, width, height }]
export function buildPdf(pages) {
  if (!pages.length) throw new Error('a document needs at least one page');

  const chunks = [];
  let length = 0;
  const push = (part) => {
    const bytes = typeof part === 'string' ? latin1(part) : part;
    chunks.push(bytes);
    length += bytes.length;
    return bytes.length;
  };

  // Object 1 is the catalogue, 2 the page list, then three objects per page:
  // the page, its content stream, and the image itself.
  const objectCount = 2 + pages.length * 3;
  const offsets = new Array(objectCount + 1).fill(0);
  const pageObject = (i) => 3 + i * 3;
  const contentObject = (i) => 4 + i * 3;
  const imageObject = (i) => 5 + i * 3;

  const begin = (number) => {
    offsets[number] = length;
    push(`${number} 0 obj\n`);
  };
  const end = () => push('endobj\n');

  push('%PDF-1.4\n');
  // A comment of high bytes, which is how a PDF announces itself as binary and
  // stops well-meaning tools from mangling line endings in the streams below.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  begin(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\n');
  end();

  begin(2);
  push(`<< /Type /Pages /Count ${pages.length} /Kids [`);
  push(pages.map((_, i) => `${pageObject(i)} 0 R`).join(' '));
  push('] >>\n');
  end();

  pages.forEach((page, i) => {
    const width = Math.max(1, Math.round(page.width * SCALE * 1000) / 1000);
    const height = Math.max(1, Math.round(page.height * SCALE * 1000) / 1000);

    begin(pageObject(i));
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] `
      + `/Resources << /XObject << /Im0 ${imageObject(i)} 0 R >> >> `
      + `/Contents ${contentObject(i)} 0 R >>\n`
    );
    end();

    // Draw the image at exactly the page size: scale, no rotation, origin at
    // the bottom left, which is where PDF puts it.
    const draw = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
    begin(contentObject(i));
    push(`<< /Length ${draw.length} >>\nstream\n`);
    push(draw);
    push('endstream\n');
    end();

    begin(imageObject(i));
    push(
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} `
      + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode '
      + `/Length ${page.jpeg.length} >>\nstream\n`
    );
    push(page.jpeg);
    push('\nendstream\n');
    end();
  });

  const xref = length;
  push(`xref\n0 ${objectCount + 1}\n`);
  push('0000000000 65535 f \n');
  for (let number = 1; number <= objectCount; number++) {
    push(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
