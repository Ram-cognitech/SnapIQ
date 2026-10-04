// Helpers for the contract tests.
//
// These tests talk to the API over HTTP and know nothing about how it is built,
// which is the point: they are the contract from docs/api.md, and the
// implementation has to satisfy them rather than the other way round.
//
// Two environment variables are needed:
//   SNAPIQ_API        base URL (default http://127.0.0.1:8787)
//   SNAPIQ_TEST_JWT   a session for the seeded test account
//
// Until the API exists these tests fail on connection refused. That is the
// right kind of failure for a specification.

import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const BASE = (process.env.SNAPIQ_API || 'http://127.0.0.1:8787').replace(/\/$/, '');

export const session = () => {
  const jwt = process.env.SNAPIQ_TEST_JWT;
  if (!jwt) throw new Error('SNAPIQ_TEST_JWT is not set: these tests need a session for the seeded account');
  return jwt;
};

// One call to the API. Never throws on a non-2xx: the status is what is asserted.
export async function api(path, { method = 'GET', token, body, headers = {}, raw = false } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

// A real PNG of the given size, built from zeroed scanlines, so a 6000 px wide
// image costs almost nothing in bytes. Used to test the pixel caps without
// shipping fixtures.
export function png(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 8 bits per channel
  ihdr[9] = 2;   // truecolour
  const scanline = Buffer.alloc(1 + width * 3);          // filter byte + RGB
  const raw = Buffer.concat(Array.from({ length: height }, () => scanline));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const megabytes = (n) => randomBytes(n * 1024 * 1024);

// Pair a phone and return its upload-only key.
export async function pairPhone(label = 'contract test') {
  const pairing = await api('/v1/pairings', { method: 'POST', token: session(), body: {} });
  if (pairing.status !== 201) throw new Error(`could not create a pairing: ${pairing.status} ${pairing.text}`);
  const claimed = await api('/v1/devices/claim', {
    method: 'POST',
    body: { claim_token: pairing.body.claim_token, label },
  });
  if (claimed.status !== 201) throw new Error(`could not claim the pairing: ${claimed.status} ${claimed.text}`);
  return { ...claimed.body, pairing: pairing.body };
}

export async function openChannel(label = 'contract test') {
  const channel = await api('/v1/channels', { method: 'POST', token: session(), body: { label } });
  if (channel.status !== 201) throw new Error(`could not open a channel: ${channel.status} ${channel.text}`);
  return channel.body;
}

// Send one page: ask for an upload address, PUT the bytes straight to storage,
// then commit. This is the whole upload path from docs/api.md section 5.
export async function sendPage(deviceKey, scanId, { index = 0, bytes, variant = 'clean', contentType = 'image/png' } = {}) {
  const digest = sha256(bytes);
  const page = await api(`/v1/scans/${scanId}/pages`, {
    method: 'POST',
    token: deviceKey,
    body: { index, bytes: bytes.length, content_type: contentType, variant, sha256: digest, idempotency_key: `page-${scanId}-${index}` },
  });
  if (page.status !== 201) return { page, committed: null };

  const put = await fetch(page.body.upload_url, {
    method: 'PUT',
    headers: { 'content-type': contentType, ...(page.body.upload_headers || {}) },
    body: bytes,
  });
  if (!put.ok) throw new Error(`storage refused the upload: ${put.status}`);

  const committed = await api(`/v1/scans/${scanId}/pages/${page.body.page_id}/commit`, {
    method: 'POST',
    token: deviceKey,
    body: { sha256: digest },
  });
  return { page, committed };
}

// Read a server-sent event stream until `wanted` events have arrived or the
// timeout passes. Resolves with whatever was collected, so a test can assert
// on "nothing arrived" as well as on what did.
export async function collectEvents(channel, { wanted = 1, timeoutMs = 5000, since } = {}) {
  const url = `${BASE}/v1/channels/${channel.channel_id}/events${since === undefined ? '' : `?since=${since}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${channel.channel_token}`, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`the event stream refused: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (events.length < wanted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
        if (data) { try { events.push(JSON.parse(data)); } catch { /* a comment or keep-alive */ } }
      }
    }
    reader.cancel().catch(() => {});
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    clearTimeout(timer);
  }
  return events;
}
