# SnapIQ

*Snap it. Perfect it. Use it anywhere!*

Scan a document, an invoice or a page with your phone. SnapIQ crops it, straightens it and
turns it into a clean PDF — on the phone itself — and it appears on whatever computer you are
working on, a second later. Other applications can receive the result through an API.

A CogniTech Studio product.

## Why it exists

Phone scanning is already free and built in: iOS, Android, Apple Notes, Adobe Scan, Microsoft
Lens. Two things those do not do, and they are the whole product:

1. **The scan lands on the computer you are already working on** — no cable, no emailing
   yourself, no cloud folder to go hunting in.
2. **Other applications can receive it directly** through an API, so a scan becomes an
   attachment, an expense line or a form field somewhere else without anyone downloading a
   file.

## Where things are

| | |
|---|---|
| [docs/plan.md](docs/plan.md) | the product and architecture plan, and the decisions behind it |
| [docs/api.md](docs/api.md) | the API v1 specification — **proposed, under review** |

## State

The API works and its 22 contract tests pass. The capture page — the part that crops,
straightens and builds the PDF on the phone — is next.

## Running it

Nothing here needs a Cloudflare account: D1 is a local SQLite file, R2 a local directory, and
the Durable Object runs in the same process. An account is needed to deploy, not to build.

```bash
npm install
npx wrangler d1 migrations apply snapiq --local
npx wrangler dev                                   # http://127.0.0.1:8787

# in another terminal
SNAPIQ_TEST_JWT=$(node scripts/token.mjs) npm test
```

`.dev.vars` holds the two local secrets (`OPERATOR_PASSPHRASE`, `SESSION_SECRET`) and is not
committed. For a deployment they are set with `wrangler secret put`.

## Shape of the build, when it starts

Free tier throughout, so it costs nothing to run while it is proven:

- **Cloudflare Pages** — the webapp and the capture page (an installable PWA), HTTPS included
- **Workers** — the API. 10 ms CPU per request on the free plan, which is why image work
  happens on the phone and uploads go straight to object storage
- **Durable Objects** — one per channel, so a scan appears on the right screen without polling
- **R2** — storage, with no egress charge
- **Supabase** — Postgres and authentication, in `ca-central-1`

Cleanup — edge detection, perspective correction, deskew, contrast, PDF assembly — runs in the
phone's browser. It costs nothing at any volume, the document is cleaned and stripped of
camera metadata *before* it leaves the device, and a bad crop can be corrected immediately
instead of after a round trip.

## Privacy, in one line

A conduit, not an archive: nothing is kept that the user has not asked us to keep, free scans
are deleted once used, metadata goes on the device, and no scan is ever used for anything but
the user's own purpose.
