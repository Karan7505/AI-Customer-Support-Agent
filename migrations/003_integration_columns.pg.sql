-- 003_integration_columns (Postgres)
-- Blueprint section 5.3/5.4: provider integration columns.
-- All nullable: existing rows keep working, provider fields fill in over time.

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "externalTrackingId" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "stripePaymentIntentId" TEXT;
ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "providerRefundId" TEXT;
