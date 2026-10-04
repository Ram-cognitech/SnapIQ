// Getting the scan onto the computer in front of you.
// docs/api.md sections 4 and 6; proofs 1, 3 and 5 of section 10.

import { describe, expect, it } from 'vitest';
import { api, collectEvents, openChannel, pairPhone, png, sendPage, session } from './helpers.js';

describe('delivery to a waiting computer', () => {
  it('a page lands on the open computer within two seconds', async () => {
    const device = await pairPhone();
    const channel = await openChannel('a question on screen');

    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { channel_id: channel.channel_id, idempotency_key: `live-${Date.now()}` },
    });
    expect(scan.status).toBe(201);

    // Start listening, then send, and measure what the person at the computer waits.
    const listening = collectEvents(channel, { wanted: 2, timeoutMs: 5000 });
    const sentAt = Date.now();
    await sendPage(device.device_key, scan.body.scan_id, { bytes: png(1200, 1600) });
    const events = await listening;
    const arrived = Date.now() - sentAt;

    expect(events.map((e) => e.event)).toContain('page.added');
    expect(arrived).toBeLessThan(2000);

    const added = events.find((e) => e.event === 'page.added');
    expect(added.scan_id).toBe(scan.body.scan_id);
    expect(added.page_count).toBe(1);
    expect(typeof added.seq).toBe('number');
  });

  it('a scan sent with no computer waiting is kept and can be picked up later', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { idempotency_key: `waiting-${Date.now()}` },     // no channel_id
    });
    expect(scan.status).toBe(201);
    await sendPage(device.device_key, scan.body.scan_id, { bytes: png(1200, 1600) });
    await api(`/v1/scans/${scan.body.scan_id}/close`, { method: 'POST', token: device.device_key, body: {} });

    const mine = await api('/v1/scans?state=closed', { token: session() });
    expect(mine.status).toBe(200);
    expect(mine.body.scans.map((s) => s.scan_id)).toContain(scan.body.scan_id);
  });

  it('polling returns exactly what the stream delivered, including after a reconnect', async () => {
    const device = await pairPhone();
    const channel = await openChannel('polling parity');
    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { channel_id: channel.channel_id, idempotency_key: `parity-${Date.now()}` },
    });

    const listening = collectEvents(channel, { wanted: 3, timeoutMs: 5000 });
    await sendPage(device.device_key, scan.body.scan_id, { bytes: png(1000, 1400) });
    await api(`/v1/scans/${scan.body.scan_id}/close`, { method: 'POST', token: device.device_key, body: {} });
    const streamed = await listening;

    const polled = await api(`/v1/channels/${channel.channel_id}/scans?since=0`, { token: channel.channel_token });
    expect(polled.status).toBe(200);

    // The permanent fallback must not be a lesser view of the world: the same
    // events, in the same order, with the same sequence numbers.
    expect(polled.body.events.map((e) => [e.event, e.seq])).toEqual(streamed.map((e) => [e.event, e.seq]));

    // And a client that dropped mid-way asks for the rest, not for everything.
    const firstSeq = streamed[0].seq;
    const rest = await api(`/v1/channels/${channel.channel_id}/scans?since=${firstSeq}`, { token: channel.channel_token });
    expect(rest.body.events.every((e) => e.seq > firstSeq)).toBe(true);
    expect(rest.body.events.length).toBe(streamed.length - 1);
  });

  it('closing the window stops the channel', async () => {
    const channel = await openChannel('window that closes');
    const closed = await api(`/v1/channels/${channel.channel_id}`, { method: 'DELETE', token: channel.channel_token });
    expect(closed.status).toBe(204);

    const afterwards = await api(`/v1/channels/${channel.channel_id}/scans?since=0`, { token: channel.channel_token });
    expect([401, 404]).toContain(afterwards.status);
  });

  it('serves the document as bytes and as a short-lived address', async () => {
    const device = await pairPhone();
    const scan = await api('/v1/scans', {
      method: 'POST',
      token: device.device_key,
      body: { idempotency_key: `fetch-${Date.now()}` },
    });
    await sendPage(device.device_key, scan.body.scan_id, { bytes: png(1200, 1600) });
    await api(`/v1/scans/${scan.body.scan_id}/close`, { method: 'POST', token: device.device_key, body: {} });

    const bytes = await fetch(`${process.env.SNAPIQ_API || 'http://127.0.0.1:8787'}/v1/scans/${scan.body.scan_id}/content`, {
      headers: { authorization: `Bearer ${session()}` },
    });
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get('content-type')).toMatch(/application\/pdf|image\//);

    // No original was sent, so there is none to hand back - and the cleaned page
    // must never be returned in its place.
    const original = await api(`/v1/scans/${scan.body.scan_id}/content?page=1&variant=original`, { token: session() });
    expect(original.status).toBe(404);
    expect(original.body.code).toBe('no_original');
  });
});
