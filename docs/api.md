# SnapIQ API — specification

Status: **proposed**, for review before implementation. The contract tests in
`tests/contract/` are written against this; implementation follows the tests.

**Scope: v0 is a working version for one person — Ram.** Everything needed to sell SnapIQ is
listed in §9 and deliberately not built. The shapes below are chosen so that growing into §9
later is additive, not a rewrite; that is the only concession made to selling.

---

## 1. The objects

- **Account** — a user. In v0 there is one, seeded; sign-up is closed.
- **Device** — a paired phone, holding an upload-only key.
- **Channel** — a computer waiting for a scan. Short-lived.
- **Scan** — one document: ordered pages, closing into a single PDF.
- **Page** — one sheet: a cleaned image, and optionally the original it came from.

A scan's life: `open → page added (×n) → closed → kept until deleted`.

## 2. Credentials (v0)

| Credential | Held by | Can do |
|---|---|---|
| Account session (JWT, Supabase Auth) | the webapp | everything for that account |
| `device_key` | a paired phone | **upload only**: open a scan, add pages, close it |
| `channel_token` | the desktop browser | read + act on **its own channel's** scans |
| `pat_…` personal access token | another app of Ram's | read scans, fetch content |

Two properties the tests must prove:

1. A `device_key` can upload and **read nothing** — every read returns `403`, including of its
   own uploads. This is what makes a long-lived key on a phone safe: lose the phone and
   someone can send documents *in*, never pull documents *out*.
2. A `channel_token` cannot see a scan that was not routed to its channel.

The personal access token is the whole of "other apps can get the output" for now — a token
and three read endpoints, instead of a key-issuing system (§9).

## 3. Pairing a phone

```
POST /v1/pairings                      (session)
→ 201 { pairing_id, claim_token, qr_url, expires_at }      # 10 minutes

POST /v1/devices/claim                 { claim_token, label? }
→ 201 { device_id, device_key }
```

`claim_token` is single-use; a second attempt is `410 claim_already_used`. `GET /v1/devices`
and `DELETE /v1/devices/{id}` are the "Paired phones" list; a revoked key fails its next
request with `401 device_revoked`. Sliding 180-day lifetime, renewed on use.

## 4. Channels — landing on the right computer

```
POST   /v1/channels                    (session)   { label?, ttl_seconds? = 900 }
→ 201 { channel_id, channel_token, phone_url, expires_at }

GET    /v1/channels/{id}/events        (channel_token)   # SSE
GET    /v1/channels/{id}/scans?since=  (channel_token)   # polling, permanent fallback
DELETE /v1/channels/{id}               (channel_token)
```

Events: `scan.opened`, `page.added`, `scan.closed`. Each carries
`{ event, scan_id, page_count, at, seq }`; `seq` rises per channel so a reconnecting browser
asks `?since=seq` and misses nothing. **Polling must return exactly what SSE delivered** —
tested, because some networks break streaming and polling is the permanent fallback.

**Routing.** A scan opened with no `channel_id` attaches to the account's most recent live
channel. With none live it simply belongs to the account and appears in "My scans".

## 5. Scanning — bytes never pass through the API

A Worker has 10 ms of CPU on the free plan, so it issues a presigned URL and the phone uploads
straight to storage.

```
POST /v1/scans                                  (device_key)
  { channel_id?, idempotency_key }
→ 201 { scan_id, state: "open" }

POST /v1/scans/{id}/pages                       (device_key)
  { index, bytes, content_type, variant: "clean"|"original", sha256, idempotency_key }
→ 201 { page_id, upload_url, upload_headers, expires_at }   # 5 minutes
        ↓  PUT <upload_url>   (phone → storage, direct)
POST /v1/scans/{id}/pages/{page_id}/commit      (device_key)  { sha256 }
→ 200 { committed: true, page_count }                        # fires page.added

POST /v1/scans/{id}/document                    (device_key)  { bytes, sha256, idempotency_key }
→ 201 { upload_url, upload_headers, expires_at }
        ↓  PUT <upload_url>   (phone → storage, direct)
POST /v1/scans/{id}/document/commit             (device_key)  { sha256 }
→ 200 { committed: true }

POST /v1/scans/{id}/close                       (device_key)  { page_order?: [page_id, …] }
→ 200 { state: "closed", page_count, pdf_ready }             # fires scan.closed
```

- `sha256` is verified at commit; a mismatch is `422 checksum_mismatch` and leaves no page.
  An uncommitted page is collected after 15 minutes.
- `idempotency_key` makes every write retry-safe — phone networks drop mid-upload.
- A `clean` page is required; an `original` is optional and kept for reprocessing.
- **The document** is the pages as one PDF, assembled on the phone (`public/pdf.js`) so each
  page's JPEG goes in whole and nothing is compressed a second time. `pdf_ready` is answered
  from whether a document actually arrived — not from there being pages, which is not the same
  thing. `GET /v1/scans/{id}/content` then returns the PDF, while `?page=n` still returns that
  page as an image.
- Pages arrive EXIF-stripped; the server strips anything remaining and sniffs content type
  rather than trusting an extension.

**Grouping shares into one document.** A page uploaded within **120 seconds** of that device's
last page joins the open scan, unless `new_scan: true` is passed. Four photos of a four-page
invoice therefore become one PDF, which is the point.

## 6. Reading

```
GET    /v1/scans?state=                 (session, channel_token, pat_)
GET    /v1/scans/{id}
GET    /v1/scans/{id}/content                       # the PDF
GET    /v1/scans/{id}/content?page=2&variant=clean|original
GET    /v1/scans/{id}/text                          # once OCR exists (§8)
DELETE /v1/scans/{id}
```

`?variant=original` returns `404 no_original` when none was kept — never the cleaned page in
its place. `content` returns bytes, and `?redirect=1` a 302 to a 5-minute signed URL: a
browser `<img>` wants the URL, a server integration wants the bytes.

**Retention in v0: scans are kept until deleted.** There is one user and he is the owner, so
there is no expiry machinery, no consume-and-delete, no quota enforcement — only a delete
button. The `consume` endpoint and retention tiers belong to §9.

## 7. Limits

| | |
|---|---|
| Cleaned page, long edge | 3500 px (≈300 DPI on A4) |
| Original kept, long edge | 4000 px (≈12 MP) |
| Byte budget | 2 MB cleaned, 4 MB original |
| Hard rejection | 10 MB per page → `413 page_too_large` |
| Pages per scan | 50 |

Pixels are capped first, bytes second: a 48 MP phone downscales predictably instead of having
its quality quietly destroyed to hit a byte count. Crop and deskew happen at native
resolution, *then* the image is downscaled — warping an already-shrunk page resamples twice
and softens small text.

## 8. OCR — on Ram's own GPU box

Right after the core loop works, not part of it. The box is a **pull consumer**: it dials out,
nothing dials in.

1. `scan.closed` enqueues a job on a Cloudflare Queue.
2. The box (Debian 12, GPU, St Louis) polls the queue's HTTP pull endpoint with a scoped API
   token, leasing a batch and acknowledging what it finishes.
3. For each page it fetches a short-lived signed URL, runs document detection and OCR on the
   GPU, and PUTs back a text layer plus a searchable PDF.
4. `POST /v1/internal/scans/{id}/ocr` (worker token) stores the text and flips
   `scan.ocr = { state: "done" }`. `GET /v1/scans/{id}/text` then works.

Design rules: **no inbound ports** on the box (admin access over an outbound tunnel, not an
open SSH port); it holds no long-lived storage credentials, only short-lived signed URLs; it
keeps nothing on local disk after a job; and the OCR path is **optional per account**, so it
can be switched off for anyone who must not have documents processed in the United States.

OCR text is stored with the account data, not on the box.

## 9. Deliberately not built — the selling machinery

Planned in `plan.md`, not in v0, and not to be designed around:

client apps with issued keys · OAuth consent · `external_user_id` and the white-label
"embedded" mode · webhooks · client-branded hostnames · storage tiers, quotas and Stripe ·
`consume` and retention policies · versioned terms acceptance · DPA, residency options and
sub-processor disclosures · server-side cleanup for API clients · delivery into a customer's
own bucket · search over stored scans · a client dashboard and public docs.

Residency is likewise deferred: with one user, on his own documents, on his own server, there
is nothing to disclose. It becomes real the day someone else signs up — at which point the
US location of the GPU box and the Canadian location of the database both need stating.

## 10. What the contract tests must prove (v0)

1. QR pairing, then a page lands on a waiting computer within two seconds over SSE.
2. A `device_key` can upload and every read returns `403`.
3. A scan sent with no live channel waits and is listable afterwards.
4. Four shares within 120 s become one four-page scan, in order.
5. Polling returns exactly what SSE delivered, including after `?since=` reconnect.
6. A 48 MP upload is capped to 4000 px; a 12 MB page is rejected, not truncated.
7. A checksum mismatch at commit leaves no page behind.
8. Every write is idempotent under its `idempotency_key`.
9. A `channel_token` cannot read another channel's scan.
10. No log line contains a token, a filename or image bytes.
