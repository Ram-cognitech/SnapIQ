# SnapIQ — product and API plan

*Snap it. Perfect it. Use it anywhere!*

A CogniTech Studio product. You scan a document, an invoice or a page with your phone, SnapIQ
cleans it up into a proper multi-page PDF, and it appears instantly on whatever computer you
are working on — and can be handed to other apps through an API.

Plan approved by Ram 2026-10-04. Specification stage; no implementation yet.

---

## 0. v0 is for one person

Ram's instruction, and it governs everything below: **a functioning version for himself first.
Plan for selling, but do not over-engineer for it.**

So v0 is the smallest thing that is genuinely useful to one person:

> Sign in. Pair the phone once with a QR. Photograph a document — one page or six. The phone
> crops, straightens and cleans it, builds a PDF, and it appears on the computer already open
> in front of him, in a second. It stays until he deletes it. Then OCR, on his own GPU box, so
> the text is searchable and copyable.

That is the product. Everything that exists only to sell it to other people — issued API keys,
OAuth, white-labelling, webhooks, quotas, storage tiers, Stripe, terms versioning, DPAs,
residency options, a customer dashboard — is **planned here and not built** (`api.md` §9).
The only concession to the future is choosing shapes that grow additively, which costs nothing
today.

**Deferred with it: the whole compliance apparatus.** With one user, scanning his own
documents, on his own server, there is nothing to disclose and nobody to disclose it to. It
becomes real the day a second person signs up — and at that point two facts need stating: the
GPU box is in the United States (St Louis), and the database is in Canada. Until then, the
privacy *engineering* still applies, because it is cheap and correct: metadata stripped on the
device, private buckets, short-lived signed URLs, nothing sensitive in logs.

The rest of this document is the longer-range plan. Read §0 as the thing being built, and the
rest as where it could go.

---

## 1. What it is, and what it is not

**For:** a professional scanning documents, invoices and pages who needs them on their
computer, not stuck on their phone.

**Not:** a children's or schoolwork product. Earlier drafts of this plan were shaped by one
in-house app's homework use case; that framing is gone. SnapIQ is a general product, and the
only thing that app gets is what every other client gets — the API.

**The honest competitive position.** Phone document scanning is free and built in: iOS and
Android camera apps, Apple Notes, Adobe Scan, Microsoft Lens, Genius Scan. "Scan with your
phone" cannot be the product. Two things those do not do:

1. **The scan lands on the computer you are already working on**, in a second, with no
   cable, no email to yourself, no cloud folder to go hunting in.
2. **Other applications can receive the output directly** through an API, so a scan becomes
   an attachment, an expense line or a form field in another product without a download.

Everything in this plan serves one of those two, or it is cut.

## 2. Decisions locked by Ram (2026-10-04)

| | |
|---|---|
| Name / slogan | SnapIQ — *Snap it. Perfect it. Use it anywhere!* |
| Owner | CogniTech Studio; repo in the CogniTech-Studio GitHub org |
| Stack | **Cloudflare + Supabase hybrid** (§4) |
| Output | **multi-page PDF is core**, not a later addition; JPEG/PNG also available per page |
| "Perfect it" | auto-crop to the page edges, deskew, contrast, metadata stripped — the heart of the product |
| Sign-up | free account; **users must accept versioned terms** to use the app |
| Retention | **the user's choice**, and it is the paywall (§3) |
| Pairing | pair the phone once: QR preferred, with a 6-digit code as the fallback. No password on the phone |
| Residency | Ram's delegation: "anywhere you feel best in terms of regulation" — decided in §6 |

## 3. Business model — storage is the paywall

- **Free:** scan, clean up, use, and it is deleted after use (or within 24 h if unused). No
  storage, so no bill for us and a genuinely useful free tier. This is also the exact shape a
  client app integrating the API needs, so API-only clients can live here.
- **Paid:** "keep my scans" — a drive the user keeps, priced by its size, the way people
  already understand cloud storage. Tiers by gigabytes; scans stay until deleted; download,
  re-export and (later) search.
- Add-ons: client-branded capture pages for companies embedding SnapIQ, data residency,
  delivery into the customer's own bucket, a signed DPA.

**Sequencing rule that falls out of this:** retention must not ship before billing. A "keep
my scans" button without a payment path is an unbounded storage bill. Free-tier
delete-after-use can ship alone; the drive cannot.

## 4. Architecture — Cloudflare + Supabase

Cloudflare for everything it is uniquely good at; Supabase for the two things Cloudflare has
no answer to (authentication and a relational database with row-level security).

| Piece | Why |
|---|---|
| **Cloudflare Pages** | the webapp and the capture page (an installable PWA) |
| **Workers** | the API |
| **Durable Objects** | one per live channel — the object holds the desktop's open connection, so an arriving page is pushed to the right screen with no polling and nothing to scale |
| **R2** | scan storage: zero egress fees, which is the dominant cost in a product that ships files |
| **Queues** | the cleanup pipeline and webhook delivery with retries |
| **KV** | API key → client app lookups at the edge |
| **Turnstile** | abuse protection on the capture endpoints, which have no login |
| **Cloudflare for SaaS** | customer-branded hostnames with certificates issued per hostname — the mechanism behind the branded-page add-on |
| **Ram's Contabo box** (Debian 12, GPU, St Louis) | OCR and heavy reprocessing, as a **pull consumer**: it dials out to the queue's HTTP endpoint with a scoped token, leases jobs, acks them. **No inbound ports**, no public TLS to manage, no long-lived storage credentials — only short-lived signed URLs, and nothing left on local disk after a job. If the box is down, scanning still works and OCR simply queues |
| **Supabase Postgres (`ca-central-1`)** | accounts, devices, client apps, scan metadata, billing state, with row-level security |
| **Supabase Auth** | sign-up, email verification, password reset, sessions. Cloudflare has no auth product, and this is the last thing worth hand-rolling |
| **Stripe** | storage subscriptions |

Workers reach Postgres through **Hyperdrive** (a Worker cannot hold a long-lived Postgres
connection), or through PostgREST for simple reads. Storage sits behind a four-method
interface (`put` / `signedUrl` / `bytes` / `delete`) **parameterised by jurisdiction**, so a
second bucket in another region is configuration, not a rewrite.

### Free to test first — and secured

Ram's requirement: something free to test, and **secured**. Both are satisfied without buying
anything. Verified free-tier allowances:

| | free tier | enough to test? |
|---|---|---|
| Cloudflare Pages | unlimited sites, HTTPS on `<project>.pages.dev`, custom domains free | yes — and HTTPS is what matters, since service workers, `share_target`, camera access and PWA install all require a secure origin |
| Workers | 100k requests/day, **10 ms CPU per invocation** | yes, once cleanup runs on the phone |
| Durable Objects | included, SQLite-backed | yes — the live channel is free, no polling fallback needed for the test |
| Queues | 10k operations/day | yes |
| R2 | 10 GB-month, 1M class A, 10M class B ops, **egress always free** | yes |
| Supabase | Postgres + Auth, 50k monthly users | yes; note a free project pauses after about a week of inactivity |
| Turnstile | free | yes |

**No domain is required.** `<project>.pages.dev` is a real, certificate-backed HTTPS origin,
and a subdomain of a domain already owned can be attached later at no cost — custom domains
on Pages are free. Testing on `pages.dev` also means **the name is not yet committed**: a
GitHub repo and a Pages project can both be renamed, so the `snapiq.com` / trademark question
does not have to be answered before building.

What "secured" means for the test deployment, concretely:

- HTTPS everywhere by default, with Cloudflare-managed certificates; HSTS on.
- **Sign-up closed to an allowlist** while testing, so a test instance never becomes an open
  door for strangers' documents. An open sign-up arrives with the terms and the privacy policy,
  not before them.
- Secrets only in Workers secrets and Supabase env; never in the repo, never in the client
  bundle. The capture page holds nothing but its own upload-only device key.
- Row-level security on from the first migration, not retrofitted.
- No client API keys issued to anybody until the API is stable and the terms exist.
- Buckets private, every read through a short-lived signed URL.

Deferred to the paid plan ($5/month Workers paid), none of it needed to test: server-side
cleanup in a Container, Cloudflare for SaaS branded hostnames, and the higher request and
queue ceilings.

### The cleanup pipeline — and why it runs on the phone

**The Workers free plan allows 10 ms of CPU per invocation.** Image cleanup does not fit in
10 ms, so the free tier cannot clean up server-side. That constraint produced a better design
rather than a worse one: **the cleanup runs on the phone, in the capture page**, before the
scan is ever uploaded.

- Edge detection, perspective correction, deskew and contrast run in the PWA (WASM —
  OpenCV.js or a smaller purpose-built kernel), and multi-page PDF assembly runs there too
  (pdf-lib). The phone has far more CPU available than a Worker invocation does, and it is
  idle while the user is looking at the page.
- Three things fall out of it: cleanup costs us nothing at any volume, the scan is already
  clean and stripped of EXIF **before it leaves the device**, and the user sees the cropped
  result immediately and can correct it rather than waiting on a server round trip.
- The Worker stays thin: authorise, store, route, notify. Comfortably inside 10 ms.
- **Server-side cleanup becomes a paid-tier fallback**, not the default: a Cloudflare
  Container driven by Queues, for client apps that upload raw bytes through the API and for
  phones too old to do the work. Phase 4, not phase 2.
### Does the raw image get uploaded too?

Ram's question, and it matters: if the automatic crop goes wrong, is there anything left to
reprocess? The paper is usually gone by then, so "rescan it" is not an answer.

**The default: the processed page goes to the server, the raw stays on the phone.** The phone
already holds the raw — it just took it — so caching it in the capture page (IndexedDB or
OPFS) keyed to the scan id, for 24–48 hours, buys the reprocessing ability for nothing. A bad
crop is redone locally and re-uploaded. No double upload, no extra storage, no extra data
held by us.

**When retention is on (the paid drive), the raw is uploaded too** — because then the
reprocessing has to work from anywhere, not just from the phone that happened to take it:

- Re-cropping on the **desktop** is a better experience than on a phone (big screen, mouse),
  and that needs the raw server-side.
- A better algorithm later can be re-run over old scans.
- Support can reproduce "it cropped my invoice wrong" instead of guessing.
- For some businesses the unaltered page is the evidential copy — a selling point for
  invoices, not just a safety net.

### Resolution and size caps — nothing is kept at full sensor resolution

Ram's point, and it is right: phone sensors keep growing (12 MP default, 48–200 MP available)
and none of that serves a document. The anchor is **300 DPI**, the threshold OCR engines ask
for and the one archival standards use; beyond it we would be storing paper grain.

| | pixels | why |
|---|---|---|
| A4 at 300 DPI | 2480 × 3508 (8.7 MP) | the target for the **finished page** — OCR-ready, archival |
| A4 at 200 DPI | 1654 × 2339 (3.9 MP) | legible, fine when OCR is not wanted |
| **capture / raw cap** | **long edge 4000 px** (~12 MP at 4:3) | the page fills only 60–80 % of the frame, so the capture must exceed the target for the *cropped* page still to reach 300 DPI |
| **finished page cap** | **long edge 3500 px** | 300 DPI on A4 with margin to spare |

Typical results: a cleaned text page at 3500 px, JPEG q80, is **0.3–1 MB** (less in
grayscale); a raw frame capped at 4000 px, q85, is **2–3.5 MB** — against 3–5 MB untouched and
far more from a 48 MP sensor.

- **Cap in pixels first, then bytes.** A pixel target gives predictable quality; a pure
  megabyte cap would silently wreck quality on a big sensor. So: downscale to the pixel
  target, encode, and only then tighten JPEG quality if a page still exceeds its byte budget
  (4 MB raw, 2 MB page). The 10 MB API limit stays as a hard rejection ceiling, not a
  silent truncation.
- **Order of operations matters:** detect the page edges and apply the perspective/deskew warp
  at native capture resolution, *then* downscale. Warping an already-downscaled image resamples
  twice and visibly softens small text.
- **Never upscale**, and never re-encode a page twice.
- HEIC from iPhones needs no special case: the capture page decodes and re-encodes through a
  canvas anyway, which is also what strips the metadata.
- Grayscale is offered and cuts size two- to threefold while helping OCR, but colour stays the
  default — invoices carry stamps, logos and highlighting that matter.

Storage consequence: roughly **3 MB per page** when a raw is kept, so the 10 GB free
allowance is about 3,300 pages, and a paid 50 GB drive is about 16,000.

Three rules that make this safe and fast:

1. **Processed first, raw second, in the background.** The processed page uploads and lands on
   the computer immediately; the raw follows as a lazy, retryable background upload. The
   "it appears in a second" promise is never paid for with the raw's bandwidth — a raw frame
   is roughly 3–5 MB against 200–600 KB for a cleaned page, so this ordering is the difference
   between instant and sluggish on mobile data.
2. **"Raw" means full-resolution, uncropped, unstraightened — but already EXIF-stripped.**
   GPS and camera metadata are removed on the device, before upload, always. We keep a
   reprocessable image, never the untouched camera file. This preserves the promise that
   nothing sensitive leaves the phone.
3. **Raws are the user's, not training data.** They are deleted with the scan, and they are
   never used to tune our algorithms without explicit, separate opt-in. Otherwise the "no use
   beyond your own purpose" commitment is worthless.

The free tier therefore stores no raws at all, which is consistent with it storing nothing —
and keeps the 10 GB free allowance from being consumed ten times faster. `?variant=original`
returns the raw where one exists, and 404s where it does not.

### Pairing and the device key

1. The signed-in webapp creates a pairing; the QR carries a one-time `claim_token`.
2. `POST /v1/devices/claim` swaps it for a `device_key` (32 random bytes, stored hashed) with
   a device id and a user-agent label. The claim dies on use, so the QR image stops being a
   credential as soon as it has worked.
3. Fallback: the phone shows a 6-digit code typed into the signed-in webapp. Covers phones
   that cannot scan.
4. **Scope: upload only, one account.** It cannot list, read, download or delete. A leaked
   key lets someone send a scan *into* the account, never pull one out — the asymmetry that
   makes a long-lived key on a phone acceptable.
5. Sliding 180-day lifetime renewed on use, 12-month ceiling, rate-limited, revocable
   instantly from "Paired phones", auto-revoked when the account closes.

### The share sheet, and the multi-page problem

- **Android:** the PWA declares `share_target` (POST, `multipart/form-data`, `image/*`), a
  service worker reads the FormData and uploads with the stored key. Camera → Share → SnapIQ.
- **iOS:** Safari has no Web Share Target. A one-tap-install Shortcut puts SnapIQ in the
  system share sheet instead and posts the file. It needs its own upload entry point, since
  it sends raw bytes rather than a browser form.
- **Multi-page from the share sheet** needs care: a user sharing four photos of a four-page
  invoice must get one PDF, not four scans. Pages arriving within a short window for the same
  device are grouped into one open scan, and the capture page shows the pages so far with
  "add another page" and "done". Share-sheet arrivals join the open scan if one is still open.

### Channels — getting it onto the right computer

`POST /v1/channels` opens a channel for a signed-in session or a client app; the QR or link
points the phone at it. A page arriving with no channel goes to that account's most recent
live channel and is pushed over it; with none live it waits in the account (free tier: 24 h).
A Durable Object per channel keeps the open connection, so "it appears on the screen" needs
no polling, with polling kept as a permanent fallback for networks that break streaming.

### API

`POST /v1/channels` · `GET /v1/channels/{id}/events` · `GET /v1/channels/{id}/scans?since=`
`POST /v1/scans` (open a scan) · `POST /v1/scans/{id}/pages` · `POST /v1/scans/{id}/close`
`GET /v1/scans?state=` · `GET /v1/scans/{id}` · `GET /v1/scans/{id}/content` (PDF, or
`?page=n&variant=original|clean`) · `POST /v1/scans/{id}/consume` · `DELETE /v1/scans/{id}`
`POST /v1/devices/claim` · `GET /v1/devices` · `DELETE /v1/devices/{id}`
plus OAuth consent endpoints so a client app can act for a SnapIQ user.

Keys: `pk_live_` (publishable, origin-allowlisted) and `sk_live_` (secret, server only, shown
once, rotatable with two live keys during rotation). `_test_` keys behave the same, bill
nothing, keep scans an hour.

Two ways a client app is wired in:
- **On behalf of a SnapIQ user** — the user authorises the app through a consent screen
  (OAuth 2.0 authorization code + PKCE) and the app reads that user's scans.
- **On behalf of its own users** — the app's server opens channels with its secret key and a
  pseudonymous `external_user_id`; its users never see SnapIQ and never sign in to it. A
  client-branded capture page is the paid add-on that completes this.

## 5. Terms, and what the user agrees to

Sign-up requires accepting a **versioned** Terms of Service and Privacy Policy; the account
records which version was accepted and when, and a version change prompts re-acceptance.
Because the paid product stores business records (invoices), the terms must state retention,
deletion, sub-processors, residency and what happens to the drive when a subscription lapses
— a grace period, then deletion, never silent destruction. These documents need a lawyer's
eye before launch; they are not a template exercise for a product holding other companies'
financial paperwork.

## 6. Residency and compliance — decided

Ram delegated this. The decision, and why:

- **Accounts, metadata and billing state: Supabase Postgres in `ca-central-1` (Canada).**
  CogniTech Studio is in Quebec, so Law 25 applies at home regardless, and — the deciding
  fact — **Canada holds a European adequacy decision**, so EU customers' personal data may
  sit in Canada without standard contractual clauses. Canada is the one location that is
  simultaneously home, EU-serviceable and close to North American users.
- **Scan files: R2, default bucket with the `enam` location hint.** Verified against
  Cloudflare's documentation: R2 offers hints (`wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`)
  which are **best-effort, not guarantees**, and strict jurisdictions for **`eu`, `us` and
  `fedramp` only — there is no Canadian jurisdiction**. So a hard "your file never leaves
  Canada" promise is not available on R2 and must not be written into any page.
- **What we therefore say:** files are processed and stored on North American infrastructure;
  accounts and metadata are in Canada; sub-processors are named (Cloudflare, Supabase,
  Stripe); free-tier scans are deleted after use.
- **Paid residency option (phase 5):** a bucket under R2's strict `eu` jurisdiction for
  customers who need a real guarantee. This is why the storage interface takes a jurisdiction
  from day one — the alternative is re-plumbing every call site later.
- Retention makes this matter more than it did when SnapIQ was a 24-hour conduit: a stored
  invoice is a business record, and some customers are obliged to know where it lives.

Also standing: no file or token in logs; no analytics on the capture page; no use of content
beyond the user's own purpose (no training, no profiling); encryption at rest; 10 MB per page
cap with real type sniffing; per-key and per-device rate limits; deletion that actually
deletes, on a schedule, not lazily when someone happens to log in.

## 7. Costs

**Building and testing it costs €0** — see the free-tier table in §4. The first bill arrives
only when the product needs server-side cleanup, branded hostnames or more than 100k requests
a day, and that bill starts at $5/month.

After that:

- Workers paid plan $5/mo; Durable Objects and Queues are usage-priced and negligible at
  this size.
- **R2: $0.015/GB-month, zero egress.** 100 GB stored is about $1.50 a month — which is what
  makes storage tiers profitable rather than frightening.
- Supabase free → $25/mo when it outgrows it.
- Stripe 2.9% + €0.30 once there is revenue. Domain ~€15/yr.
- Cloudflare for SaaS custom hostnames: bundled with paid plans, but per-hostname pricing was
  not stated in the documentation and must be confirmed before the branded-page add-on is
  priced.

**Under about €50/month until there is real volume**, and the paid tier's margin is wide
because R2 charges nothing for egress.

## 8. Phases

**Built now, for Ram:**

- **v0.1 — the spec.** `api.md`, and the contract tests from its §10 written before any
  implementation. Done when the tests exist and fail for the right reason.
- **v0.2 — the loop works.** Seeded account and sign-in, QR pairing, the capture page as an
  installable PWA, on-device cleanup (crop, deskew, contrast, multi-page PDF), direct upload to
  storage, channels over Durable Objects, and the scan appearing on the open computer. Entirely
  on free tiers, at `*.pages.dev`. **This is the version Ram uses.**
- **v0.3 — the phone gets out of the way.** Android share target, so the ordinary camera's
  Share button sends to SnapIQ; iOS Shortcut for the same gesture. "My scans" with download.
- **v0.4 — OCR on the Contabo box.** Searchable PDFs and copyable text, through the pull
  consumer above. The first thing the GPU earns its keep on.
- **v0.5 — a personal access token and three read endpoints**, so another of Ram's apps can
  fetch scans. This is the whole of "an API other apps can use", until there are other people.

**Only if it is to be sold** (planned, not built — see `api.md` §9):

- issued keys and a client dashboard, OAuth consent, the white-label embedded mode,
  webhooks, client-branded hostnames;
- storage tiers with Stripe, quotas, retention policies and `consume`;
- versioned terms, DPA, sub-processor disclosures, EU-jurisdiction residency, audit log;
- server-side cleanup for API clients that upload raw bytes, delivery into a customer's own
  bucket, search over stored scans.

The name can stay unsettled throughout: a repo and a `pages.dev` project can both be renamed,
so `snapiq.com` being parked for sale matters only when something is advertised.

Five focused hours after the repo exists reaches the end of phase 2 and some of phase 3;
estimated token cost 0.6M–1.3M.

## 9. Open questions for Ram

- Which domain eventually, once there is something to show? `snapiq.com` is for sale on the
  aftermarket and `snapiq.app` is taken by a live site, so the options are buying the `.com`
  at resale price, attaching a subdomain of a domain already owned (free), or a different
  name. **Not blocking** — the test runs on `pages.dev`.
- Storage tiers: what sizes and prices (e.g. 5 / 50 / 200 GB)? And how many scans a month on
  the free tier before it is abused?
- Which company bills, through which Stripe account, in CAD or EUR?
- Does OCR (searchable PDFs, text extraction) matter to you? It is the obvious next thing a
  professional asks for after deskew, and it would move up from phase 5.
- Who writes the Terms and Privacy Policy — a lawyer, or a first draft from me for review?
