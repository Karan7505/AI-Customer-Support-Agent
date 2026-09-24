-- Migration 001: initial schema (Postgres/Supabase dialect)
-- Source of truth for the base schema; superseded by later numbered
-- migrations. Do NOT edit after application (checksum-verified at boot).
-- Column names are camelCase to match src/db/schema.pg.ts (drizzle).
-- Monetary values are integer cents; timestamps are epoch milliseconds.

CREATE TABLE IF NOT EXISTS "customers" (
  "id"             TEXT PRIMARY KEY,
  "name"           TEXT NOT NULL,
  "email"          TEXT NOT NULL UNIQUE,
  "passwordHash"   TEXT NOT NULL,
  "role"           TEXT NOT NULL DEFAULT 'customer',
  "createdAt"      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "orders" (
  "id"                 TEXT PRIMARY KEY,
  "customerId"         TEXT NOT NULL REFERENCES "customers"("id"),
  "status"             TEXT NOT NULL DEFAULT 'pending',
  "total"              INTEGER NOT NULL,
  "currency"           TEXT NOT NULL DEFAULT 'USD',
  "items"              TEXT NOT NULL,
  "shippingAddress"    TEXT NOT NULL,
  "trackingNumber"     TEXT,
  "createdAt"          INTEGER NOT NULL,
  "deliveredAt"        INTEGER,
  "refundableAmount"   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_orders_customer" ON "orders"("customerId");

CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id"            TEXT PRIMARY KEY,
  "customerId"    TEXT NOT NULL REFERENCES "customers"("id"),
  "orderId"       TEXT,
  "subject"       TEXT NOT NULL,
  "description"   TEXT NOT NULL,
  "priority"      TEXT NOT NULL DEFAULT 'medium',
  "status"        TEXT NOT NULL DEFAULT 'open',
  "internalNotes" TEXT,
  "createdAt"     INTEGER NOT NULL,
  "updatedAt"     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_tickets_customer" ON "support_tickets"("customerId");

CREATE TABLE IF NOT EXISTS "refunds" (
  "id"              TEXT PRIMARY KEY,
  "orderId"         TEXT NOT NULL REFERENCES "orders"("id"),
  "customerId"      TEXT NOT NULL REFERENCES "customers"("id"),
  "amount"          INTEGER NOT NULL,
  "reason"          TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'requested',
  "approvalId"      TEXT,
  "idempotencyKey"  TEXT,
  "createdAt"       INTEGER NOT NULL,
  "processedAt"     INTEGER
);
CREATE INDEX IF NOT EXISTS "idx_refunds_order" ON "refunds"("orderId");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_refunds_idempotency" ON "refunds"("idempotencyKey");

CREATE TABLE IF NOT EXISTS "approval_requests" (
  "id"               TEXT PRIMARY KEY,
  "requestedBy"      TEXT NOT NULL REFERENCES "customers"("id"),
  "actorRole"        TEXT NOT NULL,
  "actionType"       TEXT NOT NULL,
  "toolName"         TEXT NOT NULL,
  "arguments"        TEXT NOT NULL,
  "riskLevel"        TEXT NOT NULL DEFAULT 'high',
  "status"           TEXT NOT NULL DEFAULT 'pending_approval',
  "approvedBy"       TEXT,
  "rejectionReason"  TEXT,
  "orderId"          TEXT,
  "amountCents"      INTEGER,
  "idempotencyKey"   TEXT,
  "createdAt"        INTEGER NOT NULL,
  "resolvedAt"       INTEGER
);
CREATE INDEX IF NOT EXISTS "idx_approvals_status" ON "approval_requests"("status");

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"             SERIAL PRIMARY KEY,
  "actorId"        TEXT NOT NULL,
  "actorRole"      TEXT NOT NULL,
  "action"         TEXT NOT NULL,
  "toolName"       TEXT,
  "arguments"      TEXT,
  "result"         TEXT,
  "approvalId"     TEXT,
  "conversationId" TEXT,
  "timestamp"      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "sessions" (
  "token"        TEXT PRIMARY KEY,
  "customerId"   TEXT NOT NULL REFERENCES "customers"("id"),
  "createdAt"    INTEGER NOT NULL,
  "expiresAt"    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "conversations" (
  "id"           TEXT PRIMARY KEY,
  "customerId"   TEXT NOT NULL REFERENCES "customers"("id"),
  "title"        TEXT NOT NULL DEFAULT 'New conversation',
  "createdAt"    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_conv_customer" ON "conversations"("customerId");

CREATE TABLE IF NOT EXISTS "messages" (
  "id"               SERIAL PRIMARY KEY,
  "conversationId"   TEXT NOT NULL REFERENCES "conversations"("id"),
  "role"             TEXT NOT NULL,
  "content"          TEXT NOT NULL,
  "meta"             TEXT,
  "createdAt"        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_messages_conv" ON "messages"("conversationId");
