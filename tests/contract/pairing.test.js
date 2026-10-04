// Pairing a phone, once, and taking it away again.
// docs/api.md section 3, and proof 1 of section 10.

import { describe, expect, it } from 'vitest';
import { api, pairPhone, png, sendPage, session } from './helpers.js';

describe('pairing a phone', () => {
  it('gives the phone an upload-only key, once', async () => {
    const pairing = await api('/v1/pairings', { method: 'POST', token: session(), body: {} });
    expect(pairing.status).toBe(201);
    expect(pairing.body.qr_url).toMatch(/^https?:\/\//);
    expect(pairing.body.claim_token).toBeTruthy();
    // Ten minutes, give or take the round trip.
    expect(new Date(pairing.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(11 * 60_000);

    const first = await api('/v1/devices/claim', {
      method: 'POST',
      body: { claim_token: pairing.body.claim_token, label: 'a phone' },
    });
    expect(first.status).toBe(201);
    expect(first.body.device_key).toBeTruthy();
    expect(first.body.device_id).toBeTruthy();

    // The QR photographed off a screen must be worthless afterwards.
    const second = await api('/v1/devices/claim', {
      method: 'POST',
      body: { claim_token: pairing.body.claim_token, label: 'someone else' },
    });
    expect(second.status).toBe(410);
    expect(second.body.code).toBe('claim_already_used');
  });

  it('lists the paired phone and revokes it for good', async () => {
    const device = await pairPhone('phone to revoke');

    const listed = await api('/v1/devices', { token: session() });
    expect(listed.status).toBe(200);
    expect(listed.body.devices.map((d) => d.device_id)).toContain(device.device_id);
    // The list is for recognising a phone, so it carries a label and a last-used date,
    // and never the key itself.
    const entry = listed.body.devices.find((d) => d.device_id === device.device_id);
    expect(entry.label).toBe('phone to revoke');
    expect(JSON.stringify(entry)).not.toContain(device.device_key);

    const removed = await api(`/v1/devices/${device.device_id}`, { method: 'DELETE', token: session() });
    expect(removed.status).toBe(204);

    // A revoked key stops working on its very next request.
    const afterwards = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { idempotency_key: 'after-revocation' },
    });
    expect(afterwards.status).toBe(401);
    expect(afterwards.body.code).toBe('device_revoked');
  });

  it('refuses a claim token that was never issued', async () => {
    const nonsense = await api('/v1/devices/claim', { method: 'POST', body: { claim_token: 'not-a-real-token' } });
    expect([400, 404]).toContain(nonsense.status);
    expect(nonsense.body.device_key).toBeUndefined();
  });

  it('lets a paired phone send a page', async () => {
    const device = await pairPhone('phone that works');
    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { idempotency_key: `smoke-${Date.now()}` },
    });
    expect(scan.status).toBe(201);
    expect(scan.body.state).toBe('open');

    const { page, committed } = await sendPage(device.device_key, scan.body.scan_id, { bytes: png(1200, 1600) });
    expect(page.status).toBe(201);
    expect(committed.status).toBe(200);
    expect(committed.body.page_count).toBe(1);
  });
});
