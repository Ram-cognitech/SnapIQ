// Several pages becoming one document, and the limits that keep a phone camera
// from sending us something absurd.
// docs/api.md sections 5 and 7; proofs 4, 6, 7 and 8 of section 10.

import { describe, expect, it } from 'vitest';
import { api, megabytes, pairPhone, png, sendPage, session, sha256 } from './helpers.js';

describe('several photos become one document', () => {
  it('four pages shared in quick succession are one four-page scan, in order', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { idempotency_key: `invoice-${Date.now()}` },
    });
    expect(scan.status).toBe(201);

    for (let index = 0; index < 4; index++) {
      const { committed } = await sendPage(device.device_key, scan.body.scan_id, { index, bytes: png(1000, 1400) });
      expect(committed.status).toBe(200);
      expect(committed.body.page_count).toBe(index + 1);
    }

    const closed = await api(`/v1/scans/${scan.body.scan_id}/close`, {
      method: 'POST',
      token: device.device_key,
      body: {},
    });
    expect(closed.status).toBe(200);
    expect(closed.body.state).toBe('closed');
    expect(closed.body.page_count).toBe(4);

    const fetched = await api(`/v1/scans/${scan.body.scan_id}`, { token: session() });
    expect(fetched.body.pages.map((p) => p.index)).toEqual([0, 1, 2, 3]);
  });

  it('a page asked for after the scan closed is refused', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { idempotency_key: `closed-${Date.now()}` },
    });
    await sendPage(device.device_key, scan.body.scan_id, { bytes: png(900, 1200) });
    await api(`/v1/scans/${scan.body.scan_id}/close`, { method: 'POST', token: device.device_key, body: {} });

    const late = await api(`/v1/scans/${scan.body.scan_id}/pages`, {
      method: 'POST',
      token: device.device_key,
      body: { index: 1, bytes: 1000, content_type: 'image/png', sha256: 'x'.repeat(64), idempotency_key: 'late' },
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('scan_closed');
  });
});

describe('limits', () => {
  it('refuses a page bigger than the hard ceiling instead of truncating it', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { idempotency_key: `huge-${Date.now()}` },
    });

    const tooBig = megabytes(12);
    const asked = await api(`/v1/scans/${scan.body.scan_id}/pages`, {
      method: 'POST',
      token: device.device_key,
      body: {
        index: 0, bytes: tooBig.length, content_type: 'image/jpeg',
        sha256: sha256(tooBig), idempotency_key: 'too-big',
      },
    });
    expect(asked.status).toBe(413);
    expect(asked.body.code).toBe('page_too_large');
  });

  it('refuses a page whose long edge is past the cap', async () => {
    // The phone is meant to downscale to 4000 px before sending. A 48 megapixel
    // frame arriving untouched is a bug on the phone, and the server says so
    // rather than storing paper grain.
    const device = await pairPhone();
    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { idempotency_key: `wide-${Date.now()}` },
    });

    const oversized = png(6000, 200);
    const { page, committed } = await sendPage(device.device_key, scan.body.scan_id, { bytes: oversized });
    const outcome = committed ?? page;
    expect([413, 422]).toContain(outcome.status);

    const fetched = await api(`/v1/scans/${scan.body.scan_id}`, { token: session() });
    expect(fetched.body.pages ?? []).toHaveLength(0);
  });

  it('rejects something that is not an image, whatever it is called', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { idempotency_key: `notimage-${Date.now()}` },
    });

    const notAnImage = Buffer.from('%PDF-1.7 this is not a photograph');
    const { page, committed } = await sendPage(device.device_key, scan.body.scan_id, {
      bytes: notAnImage,
      contentType: 'image/png',
    });
    const outcome = committed ?? page;
    expect([400, 415, 422]).toContain(outcome.status);
  });
});

describe('a flaky phone network cannot corrupt anything', () => {
  it('rejects a page whose bytes do not match what was promised', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { idempotency_key: `checksum-${Date.now()}` },
    });

    const bytes = png(1000, 1400);
    const asked = await api(`/v1/scans/${scan.body.scan_id}/pages`, {
      method: 'POST',
      token: device.device_key,
      body: {
        index: 0, bytes: bytes.length, content_type: 'image/png',
        sha256: sha256(bytes), idempotency_key: 'mismatch',
      },
    });
    expect(asked.status).toBe(201);

    // Upload different bytes than were promised.
    await fetch(asked.body.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', ...(asked.body.upload_headers || {}) },
      body: png(900, 1300),
    });

    const commit = await api(`/v1/scans/${scan.body.scan_id}/pages/${asked.body.page_id}/commit`, {
      method: 'POST',
      token: device.device_key,
      body: { sha256: sha256(bytes) },
    });
    expect(commit.status).toBe(422);
    expect(commit.body.code).toBe('checksum_mismatch');

    // And nothing half-written is left behind.
    const fetched = await api(`/v1/scans/${scan.body.scan_id}`, { token: session() });
    expect(fetched.body.pages ?? []).toHaveLength(0);
  });

  it('repeating a request with the same key changes nothing', async () => {
    const device = await pairPhone();
    const key = `retry-${Date.now()}`;

    const first = await api('/v1/scans', { method: 'POST', token: device.device_key, body: { idempotency_key: key } });
    const second = await api('/v1/scans', { method: 'POST', token: device.device_key, body: { idempotency_key: key } });
    expect(first.status).toBe(201);
    expect(second.body.scan_id).toBe(first.body.scan_id);

    // The same page, asked for twice, is one page.
    const bytes = png(1000, 1400);
    await sendPage(device.device_key, first.body.scan_id, { bytes });
    await sendPage(device.device_key, first.body.scan_id, { bytes });

    const fetched = await api(`/v1/scans/${first.body.scan_id}`, { token: session() });
    expect(fetched.body.pages).toHaveLength(1);
  });
});
