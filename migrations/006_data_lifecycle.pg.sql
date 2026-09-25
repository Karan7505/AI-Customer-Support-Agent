-- 006_data_lifecycle (Postgres)
-- Blueprint §6.3/6.6: soft-delete markers, notification preferences,
-- retention policy tracking, and health-check bookkeeping.

-- Soft-delete markers (epoch ms; NULL = active). Queries must filter
-- "deletedAt" IS NULL (enforced in src/db/repos.ts read paths).
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "deletedAt" INTEGER;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deletedAt" INTEGER;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "deletedAt" INTEGER;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "deletedAt" INTEGER;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "deletedAt" INTEGER;

-- Per-customer notification opt-out preferences (JSON, e.g. {"email": false}).
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "notificationPreferences" TEXT;

-- Retention policy tracking (blueprint §6.3 "For Data Retention").
-- Refunds are deliberately ABSENT: financial records are retained forever (§6.6).
CREATE TABLE IF NOT EXISTS "data_retention_policy" (
  "tableName" TEXT PRIMARY KEY,
  "retentionDays" INTEGER NOT NULL,
  "lastCleanup" INTEGER
);
INSERT INTO "data_retention_policy" ("tableName", "retentionDays") VALUES
  ('customers', 365),
  ('orders', 730),
  ('support_tickets', 730),
  ('conversations', 730),
  ('messages', 730),
  ('audit_logs', 1095)
ON CONFLICT ("tableName") DO NOTHING;

-- Background health-check bookkeeping (blueprint §6.3 "For Observability").
CREATE TABLE IF NOT EXISTS "health_checks" (
  "id" SERIAL PRIMARY KEY,
  "checkName" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "lastRun" INTEGER,
  "nextRun" INTEGER
);
