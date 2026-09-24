-- 002: audit_logs observability enrichment (blueprint §10.4)
-- metadata: JSON context (duration, iterations, provider ids, ...)
-- status:   success | failure for the audited operation
-- durationMs: INTEGER epoch-millisecond duration of the audited operation

ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "status" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "durationMs" INTEGER;
