// The assembled document: several pages becoming one PDF.
//
// This closes a gap the specification had before the code did - `close` used to
// answer pdf_ready from there being pages, which is not the same thing as a
// document having arrived.

import { describe, expect, it } from 'vitest';
import { BASE, api, pairPhone, png, sendPage, session, sha256 } from './helpers.js';

// A small but real PDF, built the way the phone builds one.
const pdfBytes = (pages = 1) => {
  const header = '%PDF-1.4\n';
  const body = Array.from({ length: pages }, (_, i) => `${i + 1} 0 obj\n<< /Type /Page >>\nendobj\n`).join('');
  return new TextEncoder().encode(`${header}${body}trailer\n<< /Size ${pages + 1} >>\n%%EOF\n`);
};

async function sendDocument(deviceKey, scanId, bytes) {
  const digest = sha256(bytes);
  const asked = await api(`/v1/scans/${scanId}/document`, {
    method: 'POST',
    token: deviceKey,
    body: { bytes: bytes.length, sha256: digest, idempotency_key: `doc-${scanId}` },
  });
  if (asked.status !== 201) return { asked, committed: null };

  const put = await fetch(asked.body.upload_url, {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf' },
    body: bytes,
  });
  if (!put.ok) throw new Error(`storage refused the document: ${put.status}`);

  const committed = await api(`/v1/scans/${scanId}/document/commit`, {
    method: 'POST',
    token: deviceKey,
    body: { sha256: digest },
  });
  return { asked, committed };
}

describe('the assembled document', () => {
  it('is what you get back when you ask for the scan', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', { method: 'POST', token: device.device_key, body: { idempotency_key: `doc-${Date.now()}` } });

    await sendPage(device.device_key, scan.body.scan_id, { index: 0, bytes: png(900, 1200) });
    await sendPage(device.device_key, scan.body.scan_id, { index: 1, bytes: png(900, 1200) });

    const bytes = pdfBytes(2);
    const { committed } = await sendDocument(device.device_key, scan.body.scan_id, bytes);
    expect(committed.status).toBe(200);
    expect(committed.body.committed).toBe(true);

    const closed = await api(`/v1/scans/${scan.body.scan_id}/close`, { method: 'POST', token: device.device_key, body: {} });
    expect(closed.status).toBe(200);
    expect(closed.body.page_count).toBe(2);
    // Answered from a document that arrived, not from pages existing.
    expect(closed.body.pdf_ready).toBe(true);

    const fetched = await fetch(`${BASE}/v1/scans/${scan.body.scan_id}/content`, {
      headers: { authorization: `Bearer ${session()}` },
    });
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('application/pdf');
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(bytes);
  });

  it('does not hide the individual pages', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', { method: 'POST', token: device.device_key, body: { idempotency_key: `both-${Date.now()}` } });
    await sendPage(device.device_key, scan.body.scan_id, { bytes: png(900, 1200) });
    await sendDocument(device.device_key, scan.body.scan_id, pdfBytes(1));

    // A particular page is still an image, even once the PDF exists.
    const page = await fetch(`${BASE}/v1/scans/${scan.body.scan_id}/content?page=1`, {
      headers: { authorization: `Bearer ${session()}` },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^image\//);
  });

  it('says so when no document was sent', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', { method: 'POST', token: device.device_key, body: { idempotency_key: `nodoc-${Date.now()}` } });
    await sendPage(device.device_key, scan.body.scan_id, { bytes: png(900, 1200) });

    const closed = await api(`/v1/scans/${scan.body.scan_id}/close`, { method: 'POST', token: device.device_key, body: {} });
    expect(closed.body.pdf_ready).toBe(false);
  });

  it('rejects a document whose bytes are not the ones promised, and keeps none of it', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', { method: 'POST', token: device.device_key, body: { idempotency_key: `badsum-${Date.now()}` } });
    await sendPage(device.device_key, scan.body.scan_id, { bytes: png(900, 1200) });

    const promised = pdfBytes(1);
    const asked = await api(`/v1/scans/${scan.body.scan_id}/document`, {
      method: 'POST',
      token: device.device_key,
      body: { bytes: promised.length, sha256: sha256(promised), idempotency_key: `badsum-doc-${Date.now()}` },
    });
    expect(asked.status).toBe(201);

    await fetch(asked.body.upload_url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: pdfBytes(3) });

    const committed = await api(`/v1/scans/${scan.body.scan_id}/document/commit`, {
      method: 'POST',
      token: device.device_key,
      body: { sha256: sha256(promised) },
    });
    expect(committed.status).toBe(422);
    expect(committed.body.code).toBe('checksum_mismatch');

    const closed = await api(`/v1/scans/${scan.body.scan_id}/close`, { method: 'POST', token: device.device_key, body: {} });
    expect(closed.body.pdf_ready).toBe(false);
  });

  it('cannot be read by the phone that sent it', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', { method: 'POST', token: device.device_key, body: { idempotency_key: `scope-${Date.now()}` } });
    await sendPage(device.device_key, scan.body.scan_id, { bytes: png(900, 1200) });
    await sendDocument(device.device_key, scan.body.scan_id, pdfBytes(1));

    const peek = await api(`/v1/scans/${scan.body.scan_id}/content`, { token: device.device_key });
    expect(peek.status).toBe(403);
  });
});
