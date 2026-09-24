-- 004_identity_lifecycle (Postgres)
-- Blueprint section 7.1/7.4: credential lifecycle + session activity tracking.
-- Existing (seed/demo) rows default to verified so they keep working.

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "emailVerified" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "emailVerificationToken" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "emailVerificationSentAt" INTEGER;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "emailResetToken" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "emailResetSentAt" INTEGER;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "deactivatedAt" INTEGER;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "lastActivityAt" INTEGER;
