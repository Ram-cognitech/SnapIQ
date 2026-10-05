// The SHA-256 fallback, against the published test vectors.
//
// This matters more than it looks: every page and every document is accepted
// only if its hash matches what was promised, so a hash that is subtly wrong
// would make every upload from a phone on a plain http address fail with a
// checksum error - and the error would point at the network, not at this file.

import { describe, expect, it } from 'vitest';
import { sha256Fallback, sha256Hex, uuid } from '../../public/digest.js';

const bytes = (text) => new TextEncoder().encode(text);

describe('sha256 without crypto.subtle', () => {
  it('matches the published vectors', async () => {
    expect(sha256Fallback(bytes('')))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Fallback(bytes('abc')))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Fallback(bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('agrees with the browser implementation, at every awkward length', async () => {
    // The lengths where the padding block changes are where a hand-written
    // implementation goes wrong: 55, 56 and 64 bytes especially.
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100_000]) {
      const data = new Uint8Array(length);
      for (let i = 0; i < length; i++) data[i] = (i * 31 + 7) & 0xff;
      const native = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      expect(sha256Fallback(data), `length ${length}`).toBe(native);
    }
  });

  it('uses whichever is available and gives the same answer', async () => {
    const data = bytes('a page of an invoice');
    expect(await sha256Hex(data)).toBe(sha256Fallback(data));
  });
});

describe('random ids without crypto.randomUUID', () => {
  it('looks like a version 4 uuid', () => {
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => uuid()));
    expect(seen.size).toBe(2000);
  });
});
