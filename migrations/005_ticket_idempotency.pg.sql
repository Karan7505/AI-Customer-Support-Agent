-- 005_ticket_idempotency (Postgres)
-- Blueprint section 8.2: ticket creation is idempotent per customer request
-- (same request returns the same ticket instead of creating duplicates).
ALTER TABLE support_tickets ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX idx_tickets_idempotency ON support_tickets (idempotency_key);
