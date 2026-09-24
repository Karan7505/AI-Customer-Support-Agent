-- 004_identity_lifecycle (SQLite)
-- Blueprint section 7.1/7.4: credential lifecycle + session activity tracking.
-- Existing (seed/demo) rows default to verified so they keep working.

ALTER TABLE customers ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1;
ALTER TABLE customers ADD COLUMN email_verification_token TEXT;
ALTER TABLE customers ADD COLUMN email_verification_sent_at INTEGER;
ALTER TABLE customers ADD COLUMN email_reset_token TEXT;
ALTER TABLE customers ADD COLUMN email_reset_sent_at INTEGER;
ALTER TABLE customers ADD COLUMN deactivated_at INTEGER;
ALTER TABLE sessions ADD COLUMN last_activity_at INTEGER;
