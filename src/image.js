// Is this actually an image, and how big is it?
//
// Read from the bytes themselves, never from the file name or the declared
// content type: the phone is meant to have cropped, straightened and
// downscaled the page already, and a frame arriving at full sensor resolution
// is a bug on the phone that the server should name rather than store
// (docs/api.md section 7).

// Returns { type, width, height } or null when the bytes are not an image we take.
export function describeImage(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16) return null;

  // PNG: the IHDR chunk is always first and holds the size.
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (PNG.every((b, i) => bytes[i] === b)) {
    return { type: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  }

  // JPEG: walk the segments to the start-of-frame, which carries the size.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          type: 'image/jpeg',
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
        };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      offset += 2 + view.getUint16(offset + 2);
    }
    return null;
  }

  // WebP: "RIFF....WEBP", then a VP8/VP8L/VP8X chunk.
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === 'VP8 ' && bytes.length > 30) {
      return { type: 'image/webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === 'VP8X' && bytes.length > 30) {
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { type: 'image/webp', width: w, height: h };
    }
    return { type: 'image/webp', width: 0, height: 0 };
  }

  return null;
}

export const longEdge = ({ width = 0, height = 0 }) => Math.max(width, height);
