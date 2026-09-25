-- 006_data_lifecycle (SQLite)
-- Blueprint §6.3/6.6: soft-delete markers, notification preferences,
-- retention policy tracking, and health-check bookkeeping.

-- Soft-delete markers (epoch ms; NULL = active). Queries must filter
-- deleted_at IS NULL (enforced in src/db/repos.ts read paths).
ALTER TABLE customers ADD COLUMN deleted_at INTEGER;
ALTER TABLE orders ADD COLUMN deleted_at INTEGER;
ALTER TABLE support_tickets ADD COLUMN deleted_at INTEGER;
ALTER TABLE conversations ADD COLUMN deleted_at INTEGER;
ALTER TABLE messages ADD COLUMN deleted_at INTEGER;

-- Per-customer notification opt-out preferences (JSON, e.g. {"email": false}).
ALTER TABLE customers ADD COLUMN notification_preferences TEXT;

-- Retention policy tracking (blueprint §6.3 "For Data Retention").
-- Refunds are deliberately ABSENT: financial records are retained forever (§6.6).
CREATE TABLE data_retention_policy (
  table_name TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL,
  last_cleanup INTEGER
);
INSERT INTO data_retention_policy (table_name, retention_days) VALUES
  ('customers', 365),
  ('orders', 730),
  ('support_tickets', 730),
  ('conversations', 730),
  ('messages', 730),
  ('audit_logs', 1095);

-- Background health-check bookkeeping (blueprint §6.3 "For Observability").
CREATE TABLE health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_name TEXT NOT NULL,
  status TEXT NOT NULL,
  last_run INTEGER,
  next_run INTEGER
);
