// What each credential cannot do. This is the file that matters most: it is the
// reason a long-lived key can sit on a phone at all.
// docs/api.md section 2; proofs 2, 9 and 10 of section 10.

import { describe, expect, it } from 'vitest';
import { api, openChannel, pairPhone, png, sendPage, session } from './helpers.js';

describe('a phone key can only send', () => {
  it('reads nothing at all, not even its own scan', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { idempotency_key: `own-${Date.now()}` },
    });
    expect(scan.status).toBe(201);
    await sendPage(device.device_key, scan.body.scan_id, { bytes: png(1000, 1400) });

    // Lose the phone and someone can send documents in. They must never be able
    // to pull documents out.
    const reads = [
      ['/v1/scans', 'GET'],
      [`/v1/scans/${scan.body.scan_id}`, 'GET'],
      [`/v1/scans/${scan.body.scan_id}/content`, 'GET'],
      [`/v1/scans/${scan.body.scan_id}/content?page=1&variant=original`, 'GET'],
      ['/v1/devices', 'GET'],
    ];
    for (const [path, method] of reads) {
      const attempt = await api(path, { method, token: device.device_key });
      expect(attempt.status, `${method} ${path} must be refused`).toBe(403);
      expect(attempt.body.code).toBe('forbidden_scope');
    }
  });

  it('cannot delete, and cannot pair another phone', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { idempotency_key: `nodelete-${Date.now()}` },
    });

    const deleted = await api(`/v1/scans/${scan.body.scan_id}`, { method: 'DELETE', token: device.device_key });
    expect(deleted.status).toBe(403);

    const pairing = await api('/v1/pairings', { method: 'POST', token: device.device_key, body: {} });
    expect(pairing.status).toBe(403);
  });

  it('cannot send an original while the account keeps nothing', async () => {
    // v0 has no storage tiers, so this is the free-tier rule: the raw stays on
    // the phone. docs/api.md section 5.
    const device = await pairPhone();
    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { idempotency_key: `raw-${Date.now()}` },
    });
    const { page } = await sendPage(device.device_key, scan.body.scan_id, {
      bytes: png(2000, 2600),
      variant: 'original',
    });
    expect(page.status).toBe(403);
    expect(page.body.code).toBe('originals_require_retention');
  });
});

describe('a computer sees only its own channel', () => {
  it('cannot read a scan that went to another window', async () => {
    const device = await pairPhone();
    const mine = await openChannel('my window');
    const other = await openChannel('someone else\'s window');

    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { channel_id: mine.channel_id, idempotency_key: `isolation-${Date.now()}` },
    });
    await sendPage(device.device_key, scan.body.scan_id, { bytes: png(1000, 1400) });

    const peek = await api(`/v1/channels/${mine.channel_id}/scans?since=0`, { token: other.channel_token });
    expect([403, 404]).toContain(peek.status);

    const direct = await api(`/v1/scans/${scan.body.scan_id}`, { token: other.channel_token });
    expect([403, 404]).toContain(direct.status);
  });
});

describe('credentials never come back out', () => {
  it('no error body echoes the credential that was sent', async () => {
    const device = await pairPhone();
    const refused = await api('/v1/scans', { method: 'GET', token: device.device_key });
    expect(refused.status).toBe(403);
    expect(refused.text).not.toContain(device.device_key);

    const badSession = await api('/v1/devices', { token: 'not-a-session-at-all' });
    expect(badSession.status).toBe(401);
    expect(badSession.text).not.toContain('not-a-session-at-all');
  });

  it('errors carry a stable code and a request id, and no file names', async () => {
    const missing = await api('/v1/scans/00000000-0000-0000-0000-000000000000', { token: session() });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not_found');
    expect(missing.body.request_id).toBeTruthy();
    expect(missing.text).not.toMatch(/\.(png|jpe?g|pdf|webp)\b/i);
  });

  // Proof 10 also asks that no log line contains a token, a file name or image
  // bytes. That cannot be observed over HTTP, so it is checked against the
  // implementation when logging is written, not here. Leaving it unasserted
  // rather than pretending to cover it.
});

describe('a wrong address says so', () => {
  it('answers the root without credentials, instead of demanding a sign-in', async () => {
    // The root is the app itself now, served as a static asset; what matters
    // here is that it answers rather than asking for a credential.
    const root = await api('/');
    expect(root.status).toBe(200);

    const health = await api('/health');
    expect(health.status).toBe(200);
    expect(health.body.name).toBe('SnapIQ');
  });

  it('calls an unknown address missing rather than unauthenticated', async () => {
    // Opening the wrong URL in a browser used to report an authentication
    // failure, which sent the reader looking for a credential problem that was
    // not there.
    const nowhere = await api('/not-a-real-place');
    expect(nowhere.status).toBe(404);
    expect(nowhere.body.code).toBe('not_found');
  });
});
