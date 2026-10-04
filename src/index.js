// SnapIQ v0.
//
// One account, its phones, and the documents they send. The shape of every
// route is docs/api.md; the tests in tests/contract are the authority on
// behaviour, and this file exists to satisfy them.
//
// Two things are deliberate and worth knowing before reading on:
//
//   * Image bytes never travel in a JSON body. A page is announced, uploaded
//     straight to storage through a single-use address, then committed. It
//     keeps the API cheap on CPU and means a dropped upload costs nothing.
//   * A phone's key can upload and read nothing at all. Every read route
//     refuses it before it looks anything up, so "lose the phone" means
//     someone can send documents in, never pull documents out.

import { Channel } from './channel.js';
import { db } from './db.js';
import { can, identify, mint, newClaimToken, newDeviceKey, sha256Hex, verify } from './auth.js';
import { describeImage, longEdge } from './image.js';
import { isExpired, json, noContent, plusSeconds, problem, readJson } from './http.js';

export { Channel };

const ACCOUNT = 'owner';   // v0 has one account, seeded by the first migration

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': request.headers.get('origin') ?? '*',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        },
      });
    }

    try {
      const response = await route(request, env, url, path, requestId);
      return response ?? problem('not_found', 'No such address', requestId);
    } catch (error) {
      // Never leak internals, and never log the request body: a log line must
      // not be able to carry a token or image bytes.
      console.error(`[${requestId}] ${request.method} ${path}: ${error?.message}`);
      return json(
        { type: 'https://snapiq/errors/internal', title: 'Something went wrong here', status: 500, code: 'internal', request_id: requestId },
        500
      );
    }
  },
};

async function route(request, env, url, path, requestId) {
  const store = db(env.DB);
  const method = request.method;

  // Signing in. One operator, one passphrase held as a secret: there is no
  // second user for a sign-up flow to serve, and none of Supabase Auth's
  // machinery would protect anybody today (docs/plan.md section 0).
  if (path === '/v1/session' && method === 'POST') {
    const body = await readJson(request);
    if (!env.OPERATOR_PASSPHRASE || body.passphrase !== env.OPERATOR_PASSPHRASE) {
      return problem('unauthenticated', 'That passphrase is not right', requestId);
    }
    return json({ token: await mint(env.SESSION_SECRET, { kind: 'session', sub: ACCOUNT }, 60 * 60 * 24 * 30) });
  }

  // The bytes of one page, arriving at a single-use address. Authenticated by
  // the address itself, so this route is handled before anything looks at the
  // Authorization header.
  if (path.startsWith('/v1/uploads/') && method === 'PUT') {
    return receiveBytes(request, env, store, path.slice('/v1/uploads/'.length), requestId);
  }

  // Pairing a phone, which by definition has no credential yet: this is the
  // one route that must be reachable with nothing but the claim token from the
  // QR, so it is handled before anything looks at the Authorization header.
  if (path === '/v1/devices/claim' && method === 'POST') {
    return claimPairing(request, store, requestId);
  }

  // Anything outside /v1 is not an API call, so it is not an authentication
  // failure either: opening the root in a browser should say what this is, and
  // a wrong address should say it does not exist, rather than both of them
  // asking someone to sign in.
  if (!path.startsWith('/v1/')) {
    if (path === '/' || path === '/health') {
      return json({ name: 'SnapIQ', state: 'the api is running', api: '/v1', docs: 'docs/api.md' });
    }
    return problem('not_found', 'No such address', requestId);
  }

  const caller = await identify(request, env, store);
  if (!caller) return problem('unauthenticated', 'Sign in first', requestId);
  if (caller.kind === 'device' && caller.revoked) {
    return problem('device_revoked', 'This phone is no longer paired', requestId);
  }

  // --- the webapp ---------------------------------------------------------

  if (path === '/v1/pairings' && method === 'POST') {
    if (!can(caller, 'manage')) return problem('forbidden_scope', 'Only the signed-in owner can pair a phone', requestId);
    const claimToken = newClaimToken();
    const expiresAt = plusSeconds(600);
    const id = await store.createPairing({ accountId: caller.account_id, claimHash: await sha256Hex(claimToken), expiresAt });
    return json(
      { pairing_id: id, claim_token: claimToken, qr_url: `${url.origin}/pair?t=${claimToken}`, expires_at: expiresAt },
      201
    );
  }

  if (path === '/v1/devices' && method === 'GET') {
    if (!can(caller, 'manage')) return problem('forbidden_scope', 'This credential cannot list phones', requestId);
    const { results } = await store.listDevices(caller.account_id);
    return json({
      devices: (results ?? []).map((d) => ({
        device_id: d.id, label: d.label, created_at: d.created_at, last_used_at: d.last_used_at, expires_at: d.expires_at,
      })),
    });
  }

  const deviceMatch = path.match(/^\/v1\/devices\/([^/]+)$/);
  if (deviceMatch && method === 'DELETE') {
    if (!can(caller, 'manage')) return problem('forbidden_scope', 'This credential cannot remove a phone', requestId);
    const device = await store.deviceById(deviceMatch[1], caller.account_id);
    if (!device) return problem('not_found', 'No such phone', requestId);
    await store.revokeDevice(device.id, caller.account_id);
    return noContent();
  }

  // --- windows on a computer ---------------------------------------------

  if (path === '/v1/channels' && method === 'POST') {
    if (!can(caller, 'manage')) return problem('forbidden_scope', 'This credential cannot open a window', requestId);
    const body = await readJson(request);
    const ttl = Math.min(Math.max(Number(body.ttl_seconds) || 900, 60), 3600);
    const expiresAt = plusSeconds(ttl);
    const id = await store.createChannel({ accountId: caller.account_id, label: body.label, expiresAt });
    return json(
      {
        channel_id: id,
        channel_token: await mint(env.SESSION_SECRET, { kind: 'channel', sub: caller.account_id, cid: id }, ttl + 60),
        phone_url: `${url.origin}/phone?c=${id}`,
        expires_at: expiresAt,
        retention_hours: null,          // v0 keeps a scan until it is deleted
      },
      201
    );
  }

  const channelMatch = path.match(/^\/v1\/channels\/([^/]+)(\/events|\/scans)?$/);
  if (channelMatch) {
    const channelId = channelMatch[1];
    const tail = channelMatch[2];
    if (caller.kind !== 'channel' || caller.channel_id !== channelId) {
      return problem('forbidden_scope', 'That window is not yours', requestId);
    }
    const channel = await store.channelById(channelId);
    if (!channel || channel.closed_at) return problem('not_found', 'That window is closed', requestId);

    const object = env.CHANNEL.get(env.CHANNEL.idFromName(channelId));

    if (tail === '/events' && method === 'GET') {
      const since = url.searchParams.get('since');
      return object.fetch(`https://channel/events${since ? `?since=${since}` : ''}`);
    }
    if (tail === '/scans' && method === 'GET') {
      const since = url.searchParams.get('since') ?? '0';
      const listed = await object.fetch(`https://channel/list?since=${encodeURIComponent(since)}`);
      return json(await listed.json());
    }
    if (!tail && method === 'DELETE') {
      await store.closeChannel(channelId);
      return noContent();
    }
  }

  // --- scanning -----------------------------------------------------------

  if (path === '/v1/scans' && method === 'POST') {
    if (!can(caller, 'upload')) return problem('forbidden_scope', 'Only a paired phone can start a document', requestId);
    const body = await readJson(request);
    const remembered = await replay(store, caller.device_id, body.idempotency_key);
    if (remembered) return remembered;

    // A page shared a moment after the last one is another page of the same
    // document, not a new one. Four photos of an invoice make one PDF.
    if (!body.new_scan) {
      const open = await store.openScanForDevice(caller.device_id, Number(env.GROUPING_WINDOW_SECONDS) || 120);
      if (open) {
        const reply = { scan_id: open.id, state: open.state };
        await keep(store, caller.device_id, body.idempotency_key, 201, reply);
        return json(reply, 201);
      }
    }

    let channelId = typeof body.channel_id === 'string' ? body.channel_id : null;
    if (channelId) {
      const channel = await store.channelById(channelId);
      if (!channel || channel.account_id !== caller.account_id) channelId = null;
    } else {
      const live = await store.liveChannel(caller.account_id);
      channelId = live?.id ?? null;
    }

    const scanId = await store.createScan({ accountId: caller.account_id, deviceId: caller.device_id, channelId });
    await store.touchDevice(caller.device_id);
    await announce(env, channelId, { event: 'scan.opened', scan_id: scanId, page_count: 0 });

    const reply = { scan_id: scanId, state: 'open' };
    await keep(store, caller.device_id, body.idempotency_key, 201, reply);
    return json(reply, 201);
  }

  const pagesMatch = path.match(/^\/v1\/scans\/([^/]+)\/pages$/);
  if (pagesMatch && method === 'POST') {
    if (!can(caller, 'upload')) return problem('forbidden_scope', 'Only a paired phone can add a page', requestId);
    const scan = await store.scanById(pagesMatch[1]);
    if (!scan || scan.account_id !== caller.account_id) return problem('not_found', 'No such document', requestId);
    if (scan.state !== 'open') return problem('scan_closed', 'That document is already finished', requestId);

    const body = await readJson(request);
    const remembered = await replay(store, caller.device_id, body.idempotency_key);
    if (remembered) return remembered;

    const variant = body.variant === 'original' ? 'original' : 'clean';
    if (variant === 'original' && env.ORIGINALS_ALLOWED !== 'true') {
      // The raw stays on the phone when the account keeps nothing.
      return problem('originals_require_retention', 'This account does not keep originals, so the phone keeps them instead', requestId);
    }

    const declared = Number(body.bytes);
    if (!Number.isFinite(declared) || declared <= 0) return problem('invalid_request', 'The size of the page is required', requestId);
    if (declared > Number(env.MAX_PAGE_BYTES)) {
      return problem('page_too_large', `A page may be at most ${env.MAX_PAGE_BYTES} bytes`, requestId);
    }
    if (typeof body.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.sha256)) {
      return problem('invalid_request', 'A sha256 of the page is required', requestId);
    }
    const count = await store.countPages(scan.id);
    if ((count?.n ?? 0) >= Number(env.MAX_PAGES_PER_SCAN)) {
      return problem('quota_exceeded', 'That document already has as many pages as we take', requestId);
    }

    const idx = Number.isFinite(Number(body.index)) ? Number(body.index) : (count?.n ?? 0);
    const objectKey = `${caller.account_id}/${scan.id}/${idx}-${variant}`;
    const pageId = await store.createPage({
      scanId: scan.id,
      idx,
      variant,
      objectKey,
      contentType: typeof body.content_type === 'string' ? body.content_type : 'application/octet-stream',
      bytes: declared,
      sha256: body.sha256,
    });

    const uploadToken = await mint(
      env.SESSION_SECRET,
      { kind: 'upload', sub: caller.account_id, pid: pageId, sid: scan.id },
      300
    );
    const reply = {
      page_id: pageId,
      upload_url: `${url.origin}/v1/uploads/${uploadToken}`,
      upload_headers: {},
      expires_at: plusSeconds(300),
    };
    await keep(store, caller.device_id, body.idempotency_key, 201, reply);
    return json(reply, 201);
  }

  const commitMatch = path.match(/^\/v1\/scans\/([^/]+)\/pages\/([^/]+)\/commit$/);
  if (commitMatch && method === 'POST') {
    if (!can(caller, 'upload')) return problem('forbidden_scope', 'Only a paired phone can finish a page', requestId);
    return commitPage(request, env, store, commitMatch[1], commitMatch[2], caller, requestId);
  }

  const closeMatch = path.match(/^\/v1\/scans\/([^/]+)\/close$/);
  if (closeMatch && method === 'POST') {
    if (!can(caller, 'upload')) return problem('forbidden_scope', 'Only a paired phone can finish a document', requestId);
    const scan = await store.scanById(closeMatch[1]);
    if (!scan || scan.account_id !== caller.account_id) return problem('not_found', 'No such document', requestId);
    const count = await store.countPages(scan.id);
    if (scan.state === 'open') await store.closeScan(scan.id);
    await announce(env, scan.channel_id, { event: 'scan.closed', scan_id: scan.id, page_count: count?.n ?? 0 });
    return json({ scan_id: scan.id, state: 'closed', page_count: count?.n ?? 0, pdf_ready: (count?.n ?? 0) > 0 });
  }

  // --- reading ------------------------------------------------------------

  if (path === '/v1/scans' && method === 'GET') {
    if (!can(caller, 'read')) return problem('forbidden_scope', 'This credential cannot read documents', requestId);
    const state = url.searchParams.get('state');
    const { results } = await store.listScans(caller.account_id, state && state !== 'all' ? state : null);
    return json({ scans: results ?? [] });
  }

  const scanMatch = path.match(/^\/v1\/scans\/([^/]+)$/);
  if (scanMatch && (method === 'GET' || method === 'DELETE')) {
    if (method === 'GET' && !can(caller, 'read') && !can(caller, 'read:channel')) {
      return problem('forbidden_scope', 'This credential cannot read documents', requestId);
    }
    if (method === 'DELETE' && !can(caller, 'write')) {
      return problem('forbidden_scope', 'This credential cannot delete documents', requestId);
    }
    const scan = await store.scanById(scanMatch[1]);
    if (!scan || scan.account_id !== caller.account_id) return problem('not_found', 'No such document', requestId);
    // A window sees only what was sent to it.
    if (caller.kind === 'channel' && scan.channel_id !== caller.channel_id) {
      return problem('not_found', 'No such document', requestId);
    }

    if (method === 'DELETE') {
      const { results } = await store.listPages(scan.id, 'clean');
      const originals = await store.listPages(scan.id, 'original');
      await env.FILES.delete([...(results ?? []), ...(originals.results ?? [])].map((p) => `${scan.account_id}/${scan.id}/${p.index}-${p.variant}`));
      await store.deleteScan(scan.id, caller.account_id);
      return noContent();
    }

    const { results } = await store.listPages(scan.id, 'clean');
    return json({
      scan_id: scan.id,
      state: scan.state,
      created_at: scan.created_at,
      closed_at: scan.closed_at,
      channel_id: scan.channel_id,
      page_count: results?.length ?? 0,
      pages: results ?? [],
    });
  }

  const contentMatch = path.match(/^\/v1\/scans\/([^/]+)\/content$/);
  if (contentMatch && method === 'GET') {
    if (!can(caller, 'read') && !can(caller, 'read:channel')) {
      return problem('forbidden_scope', 'This credential cannot read documents', requestId);
    }
    return serveContent(env, store, contentMatch[1], url, caller, requestId);
  }

  return null;
}

// --- helpers --------------------------------------------------------------

async function claimPairing(request, store, requestId) {
  const body = await readJson(request);
  if (typeof body.claim_token !== 'string' || !body.claim_token) {
    return problem('invalid_request', 'A claim token is required', requestId);
  }
  const pairing = await store.pairingByClaimHash(await sha256Hex(body.claim_token));
  if (!pairing) return problem('not_found', 'That code is not one of ours', requestId);
  // A QR photographed off a screen has to be worthless once it has worked.
  if (pairing.claimed_at) return problem('claim_already_used', 'That code has already paired a phone', requestId);
  if (isExpired(pairing.expires_at)) return problem('claim_already_used', 'That code has expired', requestId);

  const deviceKey = newDeviceKey();
  const deviceId = await store.createDevice({
    accountId: pairing.account_id,
    keyHash: await sha256Hex(deviceKey),
    label: typeof body.label === 'string' && body.label ? body.label.slice(0, 80) : 'a phone',
    expiresAt: plusSeconds(60 * 60 * 24 * 180),
  });
  await store.markPairingClaimed(pairing.id);
  return json({ device_id: deviceId, device_key: deviceKey, account_id: pairing.account_id }, 201);
}

async function receiveBytes(request, env, store, token, requestId) {
  const claims = await verify(env.SESSION_SECRET, token);
  if (!claims || claims.kind !== 'upload') return problem('unauthenticated', 'That upload address is not valid any more', requestId);

  const page = await store.pageById(claims.pid);
  if (!page) return problem('not_found', 'No such page', requestId);

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > Number(env.MAX_PAGE_BYTES)) {
    return problem('page_too_large', 'That page is too big', requestId);
  }

  // What actually arrived is recorded here and judged at commit, so a bad
  // upload fails in one place with one error.
  const described = describeImage(bytes) ?? {};
  await env.FILES.put(page.object_key, bytes, {
    httpMetadata: { contentType: described.type ?? page.content_type },
    customMetadata: {
      sha256: await sha256Hex(bytes),
      width: String(described.width ?? 0),
      height: String(described.height ?? 0),
      type: described.type ?? '',
    },
  });
  return json({ received: bytes.length });
}

async function commitPage(request, env, store, scanId, pageId, caller, requestId) {
  const scan = await store.scanById(scanId);
  if (!scan || scan.account_id !== caller.account_id) return problem('not_found', 'No such document', requestId);
  const page = await store.pageById(pageId);
  if (!page || page.scan_id !== scan.id) return problem('not_found', 'No such page', requestId);

  // Already committed: a retry, not a second page.
  if (page.committed_at) {
    const count = await store.countPages(scan.id);
    return json({ committed: true, page_count: count?.n ?? 0 });
  }

  const stored = await env.FILES.head(page.object_key);
  const drop = async (code, detail) => {
    await env.FILES.delete(page.object_key);
    await store.dropPage(page.id);
    return problem(code, detail, requestId);
  };

  if (!stored) return drop('invalid_request', 'The bytes of that page never arrived');

  const body = await readJson(request);
  const promised = typeof body.sha256 === 'string' ? body.sha256 : page.sha256;
  const actual = stored.customMetadata?.sha256;
  if (!actual || actual !== promised || promised !== page.sha256) {
    // Nothing half-written is left behind.
    return drop('checksum_mismatch', 'The bytes that arrived are not the ones promised');
  }

  const type = stored.customMetadata?.type;
  if (!type) return drop('unsupported_page', 'That file is not an image we can read');

  const size = { width: Number(stored.customMetadata?.width ?? 0), height: Number(stored.customMetadata?.height ?? 0) };
  const cap = Number(page.variant === 'original' ? env.MAX_LONG_EDGE_ORIGINAL : env.MAX_LONG_EDGE_CLEAN);
  if (longEdge(size) > cap) {
    // The phone is meant to have downscaled this. Saying so is more useful
    // than quietly storing paper grain.
    return drop('page_too_large', `A page may be at most ${cap} pixels on its long edge; this one is ${longEdge(size)}`);
  }

  await store.commitPage({ id: page.id, width: size.width, height: size.height });
  await store.touchScan(scan.id);
  const count = await store.countPages(scan.id);
  await announce(env, scan.channel_id, { event: 'page.added', scan_id: scan.id, page_count: count?.n ?? 0 });
  return json({ committed: true, page_count: count?.n ?? 0 });
}

async function serveContent(env, store, scanId, url, caller, requestId) {
  const scan = await store.scanById(scanId);
  if (!scan || scan.account_id !== caller.account_id) return problem('not_found', 'No such document', requestId);
  if (caller.kind === 'channel' && scan.channel_id !== caller.channel_id) {
    return problem('not_found', 'No such document', requestId);
  }

  const variant = url.searchParams.get('variant') === 'original' ? 'original' : 'clean';
  const asked = url.searchParams.get('page');
  const idx = asked === null ? null : Number(asked) - 1;      // ?page=1 is the first page

  const page = idx === null
    ? (await store.listPages(scan.id, variant)).results?.[0]
    : await store.pageAt(scan.id, idx, variant);

  if (!page) {
    // An original that was never kept must say so, and never hand back the
    // cleaned page in its place.
    return problem(variant === 'original' ? 'no_original' : 'not_found', variant === 'original' ? 'No original was kept for this page' : 'No such page', requestId);
  }

  const key = `${scan.account_id}/${scan.id}/${page.index ?? page.idx}-${variant}`;
  const object = await env.FILES.get(key);
  if (!object) return problem('not_found', 'Those bytes are gone', requestId);

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? page.content_type ?? 'application/octet-stream',
      'cache-control': 'private, no-store',
    },
  });
}

// Tell the window, if there is one. A scan with nobody watching simply waits.
async function announce(env, channelId, event) {
  if (!channelId) return;
  const object = env.CHANNEL.get(env.CHANNEL.idFromName(channelId));
  await object.fetch('https://channel/publish', {
    method: 'POST',
    body: JSON.stringify(event),
    headers: { 'content-type': 'application/json' },
  });
}

async function replay(store, actor, key) {
  if (!actor || typeof key !== 'string' || !key) return null;
  const remembered = await store.rememberedResponse(actor, key);
  if (!remembered) return null;
  return json(JSON.parse(remembered.response), remembered.status);
}

async function keep(store, actor, key, status, response) {
  if (!actor || typeof key !== 'string' || !key) return;
  await store.remember(actor, key, status, response);
}
