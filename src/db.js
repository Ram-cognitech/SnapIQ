// Every query in one place.
//
// v0 stores this in D1 (SQLite). The day there is a second user it moves to
// Postgres for row-level security, and this file is the whole of that move -
// nothing above it writes SQL.

export const newId = () => crypto.randomUUID();

export const db = (D1) => ({
  // --- phones -------------------------------------------------------------

  async createPairing({ accountId, claimHash, expiresAt }) {
    const id = newId();
    await D1.prepare(
      `INSERT INTO pairings (id, account_id, claim_hash, created_at, expires_at)
       VALUES (?, ?, ?, datetime('now'), ?)`
    ).bind(id, accountId, claimHash, expiresAt).run();
    return id;
  },

  pairingByClaimHash: (hash) =>
    D1.prepare('SELECT * FROM pairings WHERE claim_hash = ?').bind(hash).first(),

  markPairingClaimed: (id) =>
    D1.prepare("UPDATE pairings SET claimed_at = datetime('now') WHERE id = ?").bind(id).run(),

  async createDevice({ accountId, keyHash, label, expiresAt }) {
    const id = newId();
    await D1.prepare(
      `INSERT INTO devices (id, account_id, key_hash, label, created_at, expires_at)
       VALUES (?, ?, ?, ?, datetime('now'), ?)`
    ).bind(id, accountId, keyHash, label, expiresAt).run();
    return id;
  },

  deviceByKeyHash: (hash) =>
    D1.prepare('SELECT * FROM devices WHERE key_hash = ?').bind(hash).first(),

  listDevices: (accountId) =>
    D1.prepare(
      `SELECT id, label, created_at, last_used_at, expires_at FROM devices
       WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`
    ).bind(accountId).all(),

  deviceById: (id, accountId) =>
    D1.prepare('SELECT * FROM devices WHERE id = ? AND account_id = ?').bind(id, accountId).first(),

  revokeDevice: (id, accountId) =>
    D1.prepare("UPDATE devices SET revoked_at = datetime('now') WHERE id = ? AND account_id = ?")
      .bind(id, accountId).run(),

  touchDevice: (id) =>
    D1.prepare("UPDATE devices SET last_used_at = datetime('now') WHERE id = ?").bind(id).run(),

  // --- windows ------------------------------------------------------------

  async createChannel({ accountId, label, expiresAt }) {
    const id = newId();
    await D1.prepare(
      `INSERT INTO channels (id, account_id, label, created_at, expires_at)
       VALUES (?, ?, ?, datetime('now'), ?)`
    ).bind(id, accountId, label ?? null, expiresAt).run();
    return id;
  },

  channelById: (id) => D1.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first(),

  closeChannel: (id) =>
    D1.prepare("UPDATE channels SET closed_at = datetime('now') WHERE id = ?").bind(id).run(),

  // The window a scan goes to when the phone did not name one: the newest
  // one still open.
  liveChannel: (accountId) =>
    D1.prepare(
      `SELECT * FROM channels
       WHERE account_id = ? AND closed_at IS NULL AND expires_at > datetime('now')
       ORDER BY created_at DESC LIMIT 1`
    ).bind(accountId).first(),

  // --- documents ----------------------------------------------------------

  async createScan({ accountId, deviceId, channelId }) {
    const id = newId();
    await D1.prepare(
      `INSERT INTO scans (id, account_id, device_id, channel_id, state, created_at, last_page_at)
       VALUES (?, ?, ?, ?, 'open', datetime('now'), datetime('now'))`
    ).bind(id, accountId, deviceId ?? null, channelId ?? null).run();
    return id;
  },

  scanById: (id) => D1.prepare('SELECT * FROM scans WHERE id = ?').bind(id).first(),

  listScans: (accountId, state) =>
    state
      ? D1.prepare(
          `SELECT id AS scan_id, state, created_at, closed_at, channel_id FROM scans
           WHERE account_id = ? AND state = ? ORDER BY created_at DESC LIMIT 200`
        ).bind(accountId, state).all()
      : D1.prepare(
          `SELECT id AS scan_id, state, created_at, closed_at, channel_id FROM scans
           WHERE account_id = ? ORDER BY created_at DESC LIMIT 200`
        ).bind(accountId).all(),

  // The open scan this device was last adding to, if it is recent enough that
  // the next share is obviously another page of the same document.
  openScanForDevice: (deviceId, windowSeconds) =>
    D1.prepare(
      `SELECT * FROM scans
       WHERE device_id = ? AND state = 'open'
         AND last_page_at > datetime('now', ?)
       ORDER BY last_page_at DESC LIMIT 1`
    ).bind(deviceId, `-${windowSeconds} seconds`).first(),

  closeScan: (id) =>
    D1.prepare("UPDATE scans SET state = 'closed', closed_at = datetime('now') WHERE id = ?").bind(id).run(),

  touchScan: (id) =>
    D1.prepare("UPDATE scans SET last_page_at = datetime('now') WHERE id = ?").bind(id).run(),

  deleteScan: (id, accountId) =>
    D1.prepare('DELETE FROM scans WHERE id = ? AND account_id = ?').bind(id, accountId).run(),

  // --- the assembled document ---------------------------------------------

  promiseDocument: ({ scanId, key, sha, bytes }) =>
    D1.prepare(
      'UPDATE scans SET document_key = ?, document_sha = ?, document_bytes = ?, document_at = NULL WHERE id = ?'
    ).bind(key, sha, bytes, scanId).run(),

  commitDocument: (scanId) =>
    D1.prepare("UPDATE scans SET document_at = datetime('now') WHERE id = ?").bind(scanId).run(),

  clearDocument: (scanId) =>
    D1.prepare(
      'UPDATE scans SET document_key = NULL, document_sha = NULL, document_bytes = NULL, document_at = NULL WHERE id = ?'
    ).bind(scanId).run(),

  // --- pages --------------------------------------------------------------

  async createPage({ scanId, idx, variant, objectKey, contentType, bytes, sha256 }) {
    const id = newId();
    await D1.prepare(
      `INSERT INTO pages (id, scan_id, idx, variant, object_key, content_type, bytes, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(id, scanId, idx, variant, objectKey, contentType, bytes, sha256).run();
    return id;
  },

  pageById: (id) => D1.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first(),

  commitPage: ({ id, width, height }) =>
    D1.prepare("UPDATE pages SET committed_at = datetime('now'), width = ?, height = ? WHERE id = ?")
      .bind(width ?? null, height ?? null, id).run(),

  dropPage: (id) => D1.prepare('DELETE FROM pages WHERE id = ?').bind(id).run(),

  // Only committed pages count: a page whose bytes never arrived, or arrived
  // wrong, must not show up as part of the document.
  listPages: (scanId, variant = 'clean') =>
    D1.prepare(
      `SELECT id AS page_id, idx AS "index", variant, content_type, bytes, width, height
       FROM pages WHERE scan_id = ? AND variant = ? AND committed_at IS NOT NULL
       ORDER BY idx`
    ).bind(scanId, variant).all(),

  countPages: (scanId) =>
    D1.prepare(
      "SELECT COUNT(*) AS n FROM pages WHERE scan_id = ? AND variant = 'clean' AND committed_at IS NOT NULL"
    ).bind(scanId).first(),

  pageAt: (scanId, idx, variant) =>
    D1.prepare(
      'SELECT * FROM pages WHERE scan_id = ? AND idx = ? AND variant = ? AND committed_at IS NOT NULL'
    ).bind(scanId, idx, variant).first(),

  // --- retries ------------------------------------------------------------

  rememberedResponse: (actor, key) =>
    D1.prepare('SELECT status, response FROM idempotency WHERE actor = ? AND key = ?').bind(actor, key).first(),

  remember: (actor, key, status, response) =>
    D1.prepare(
      `INSERT OR IGNORE INTO idempotency (actor, key, status, response, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).bind(actor, key, status, JSON.stringify(response)).run(),
});
