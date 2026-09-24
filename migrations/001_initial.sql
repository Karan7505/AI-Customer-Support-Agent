-- Migration 001: initial schema (SQLite dialect)
-- Source of truth for the base schema; superseded by later numbered
-- migrations. Do NOT edit after application (checksum-verified at boot).
-- Monetary values stored as INTEGER cents. Timestamps as INTEGER epoch ms.

CREATE TABLE IF NOT EXISTS customers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'customer',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  status           TEXT NOT NULL DEFAULT 'pending',
  total            INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'USD',
  items            TEXT NOT NULL,
  shipping_address TEXT NOT NULL,
  tracking_number  TEXT,
  created_at       INTEGER NOT NULL,
  delivered_at     INTEGER,
  refundable_amount INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS support_tickets (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  order_id       TEXT,
  subject        TEXT NOT NULL,
  description    TEXT NOT NULL,
  priority       TEXT NOT NULL DEFAULT 'medium',
  status         TEXT NOT NULL DEFAULT 'open',
  internal_notes TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_customer ON support_tickets(customer_id);

CREATE TABLE IF NOT EXISTS refunds (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id),
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  amount           INTEGER NOT NULL,
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'requested',
  approval_id      TEXT,
  idempotency_key  TEXT,
  created_at       INTEGER NOT NULL,
  processed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_refunds_idempotency ON refunds(idempotency_key);

CREATE TABLE IF NOT EXISTS approval_requests (
  id               TEXT PRIMARY KEY,
  requested_by     TEXT NOT NULL REFERENCES customers(id),
  actor_role       TEXT NOT NULL,
  action_type      TEXT NOT NULL,
  tool_name        TEXT NOT NULL,
  arguments        TEXT NOT NULL,
  risk_level       TEXT NOT NULL DEFAULT 'high',
  status           TEXT NOT NULL DEFAULT 'pending_approval',
  approved_by      TEXT,
  rejection_reason TEXT,
  order_id         TEXT,
  amount_cents     INTEGER,
  idempotency_key  TEXT,
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approval_requests(status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id        TEXT NOT NULL,
  actor_role      TEXT NOT NULL,
  action          TEXT NOT NULL,
  tool_name       TEXT,
  arguments       TEXT,
  result          TEXT,
  approval_id     TEXT,
  conversation_id TEXT,
  timestamp       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  title       TEXT NOT NULL DEFAULT 'New conversation',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_customer ON conversations(customer_id);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  meta            TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
