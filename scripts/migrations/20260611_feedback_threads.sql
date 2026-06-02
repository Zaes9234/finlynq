-- Two-way feedback reply thread (2026-06-11).
--
-- Turns each feedback item into a follow-up thread: the admin can reply to the
-- user and the user can reply back. feedback.message stays the immutable SEED
-- (no backfill); a thread renders as [seed bubble] + feedback_messages in
-- order. Plaintext, same rationale as feedback.message (the maintainer must
-- read user replies; the user's per-user DEK is unreadable by an admin).
--
-- author_role is enforced at the route layer (mirrors the no-CHECK convention
-- already used on feedback.type / feedback.status).
--
-- ⚠️ Do NOT backfill feedback.message into feedback_messages — the unread-for-
-- admin signal keys on feedback_messages rows with author_role='user', so a
-- backfilled seed would make every brand-new thread look like an unread reply.

CREATE TABLE IF NOT EXISTS feedback_messages (
  id          SERIAL       PRIMARY KEY,
  feedback_id INTEGER      NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  author_role TEXT         NOT NULL,            -- 'user' | 'admin'
  author_id   TEXT         NOT NULL,
  body        TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Hot path: load one thread's messages in chronological order.
CREATE INDEX IF NOT EXISTS feedback_messages_thread_idx
  ON feedback_messages (feedback_id, created_at);

-- Two-sided read tracking (per-thread 1:2 relationship — the owning user and
-- the admin reader — so columns are the correct normal form, not a join table).
-- NULL = never opened. Unread-for-user = an admin message newer than
-- user_last_read_at; unread-for-admin = a user message newer than
-- admin_last_read_at.
ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS user_last_read_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_last_read_at TIMESTAMPTZ;
