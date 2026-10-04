// Who is asking, and what that lets them do.
//
// Four kinds of credential, and the differences between them are the whole
// security model (docs/api.md section 2):
//
//   session  the webapp, signed in as the owner      - everything
//   device   a paired phone                          - UPLOAD ONLY
//   channel  one open window on one computer         - read its own channel
//   upload   one page, once, straight into storage   - write those bytes
//
// The device key reading nothing is the point: lose the phone and someone can
// send documents in, never pull documents out.

const encoder = new TextEncoder();

export const SCOPES = {
  session: ['read', 'write', 'manage'],
  device: ['upload'],
  channel: ['read:channel'],
  upload: ['upload:page'],
};

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const base64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromBase64url = (text) => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

const key = async (secret) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

// A signed, self-describing token. Used for sessions, channels and single-page
// uploads, so none of them needs a row in the database.
export async function mint(secret, claims, ttlSeconds) {
  const payload = { ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = base64url(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body)));
  return `${body}.${signature}`;
}

export async function verify(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await key(secret), fromBase64url(signature), encoder.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
  } catch {
    return null;
  }
  if (!claims.exp || claims.exp * 1000 <= Date.now()) return null;
  return claims;
}

export const bearer = (request) => {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
};

// A phone's key is a plain random string, not a signed token: it has to be
// revocable the instant the phone is lost, which means a lookup.
export const newDeviceKey = () =>
  'dk_' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const newClaimToken = () =>
  'ct_' + [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Resolve whoever is calling into { kind, account_id, … } or null.
export async function identify(request, env, db) {
  const token = bearer(request);
  if (!token) return null;

  if (token.startsWith('dk_')) {
    const device = await db.deviceByKeyHash(await sha256Hex(token));
    if (!device) return { kind: 'device', revoked: true };
    if (device.revoked_at || new Date(device.expires_at).getTime() <= Date.now()) {
      return { kind: 'device', revoked: true };
    }
    return { kind: 'device', account_id: device.account_id, device_id: device.id, device };
  }

  const claims = await verify(env.SESSION_SECRET, token);
  if (!claims) return null;
  if (claims.kind === 'session') return { kind: 'session', account_id: claims.sub };
  if (claims.kind === 'channel') return { kind: 'channel', account_id: claims.sub, channel_id: claims.cid };
  if (claims.kind === 'upload') {
    return { kind: 'upload', account_id: claims.sub, page_id: claims.pid, scan_id: claims.sid };
  }
  return null;
}

export const can = (caller, scope) => Boolean(caller && SCOPES[caller.kind]?.includes(scope));
