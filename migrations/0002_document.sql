-- The assembled document.
--
-- Pages are the sheets; the document is the single PDF the pages were put
-- into, built on the phone (public/pdf.js) so the JPEGs go in whole and
-- nothing is compressed a second time. `close` reports pdf_ready from this,
-- which until now it promised without anywhere to keep the answer.

ALTER TABLE scans ADD COLUMN document_key TEXT;
ALTER TABLE scans ADD COLUMN document_sha TEXT;
ALTER TABLE scans ADD COLUMN document_bytes INTEGER;
ALTER TABLE scans ADD COLUMN document_at TEXT;   -- NULL until the bytes arrived and matched
