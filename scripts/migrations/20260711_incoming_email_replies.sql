-- Persist admin contact-inbox replies so /admin/inbox shows the full
-- conversation (their inbound messages + our outbound replies) and the
-- maintainer can follow / continue a thread instead of losing sent replies
-- to the Resend dashboard.
--
-- Plaintext + no user_id, mirroring incoming_emails (admin-triage table).
CREATE TABLE IF NOT EXISTS incoming_email_replies (
  id                TEXT PRIMARY KEY,
  incoming_email_id TEXT NOT NULL REFERENCES incoming_emails(id) ON DELETE CASCADE,
  to_address        TEXT NOT NULL,
  from_address      TEXT NOT NULL,
  subject           TEXT,
  body              TEXT NOT NULL,
  sent_by           TEXT REFERENCES users(id),
  resend_id         TEXT,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incoming_email_replies_email
  ON incoming_email_replies (incoming_email_id);
CREATE INDEX IF NOT EXISTS idx_incoming_email_replies_to
  ON incoming_email_replies (lower(to_address));
