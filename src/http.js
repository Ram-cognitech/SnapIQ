// Replies, and the shape of a refusal.
//
// Every error carries a stable machine code and a request id, and never a
// token, a file name or image bytes - docs/api.md section 8. The contract
// tests assert that, so this is the only place an error is built.

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const TITLES = {
  invalid_request: 'That request does not make sense',
  unauthenticated: 'Sign in first',
  device_revoked: 'This phone is no longer paired',
  forbidden_scope: 'This credential is not allowed to do that',
  originals_require_retention: 'This account does not keep originals',
  not_found: 'There is nothing here',
  no_original: 'No original was kept for this page',
  scan_closed: 'That document is already finished',
  claim_already_used: 'That code has already been used',
  page_too_large: 'That page is too big',
  unsupported_page: 'That file is not an image',
  checksum_mismatch: 'The bytes that arrived are not the ones promised',
  rate_limited: 'Too many requests',
  quota_exceeded: 'No room left',
};

const STATUSES = {
  invalid_request: 400,
  unauthenticated: 401,
  device_revoked: 401,
  forbidden_scope: 403,
  originals_require_retention: 403,
  not_found: 404,
  no_original: 404,
  scan_closed: 409,
  claim_already_used: 410,
  page_too_large: 413,
  unsupported_page: 415,
  checksum_mismatch: 422,
  rate_limited: 429,
  quota_exceeded: 507,
};

export function problem(code, detail, requestId, extra = {}) {
  const status = STATUSES[code] ?? 400;
  return json(
    {
      type: `https://snapiq/errors/${code}`,
      title: TITLES[code] ?? 'Something went wrong',
      status,
      code,
      // `detail` is written by us, never echoed from the request, so a
      // credential someone sent cannot come back out in the reply.
      detail: detail ?? TITLES[code] ?? '',
      request_id: requestId,
      ...extra,
    },
    status
  );
}

export const noContent = () => new Response(null, { status: 204 });

export const nowIso = () => new Date().toISOString();

export const plusSeconds = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();

export const isExpired = (iso) => !iso || new Date(iso).getTime() <= Date.now();

export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}
