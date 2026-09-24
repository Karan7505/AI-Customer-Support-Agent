-- 002: audit_logs observability enrichment (blueprint §10.4)
-- metadata: JSON context (duration, iterations, provider ids, ...)
-- status:   success | failure for the audited operation
-- duration_ms: INTEGER epoch-millisecond duration of the audited operation

ALTER TABLE audit_logs ADD COLUMN metadata TEXT;
ALTER TABLE audit_logs ADD COLUMN status TEXT;
ALTER TABLE audit_logs ADD COLUMN duration_ms INTEGER;
