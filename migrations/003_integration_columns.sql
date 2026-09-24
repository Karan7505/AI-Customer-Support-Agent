-- 003_integration_columns (SQLite)
-- Blueprint section 5.3/5.4: provider integration columns.
-- All nullable: existing rows keep working, provider fields fill in over time.

ALTER TABLE orders ADD COLUMN external_tracking_id TEXT;
ALTER TABLE orders ADD COLUMN stripe_payment_intent_id TEXT;
ALTER TABLE refunds ADD COLUMN provider_refund_id TEXT;
