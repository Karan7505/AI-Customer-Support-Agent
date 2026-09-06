/**
 * Seed realistic demo data so the app is demonstrable without manual entry.
 *   npx tsx src/db/seed.ts          # seed if empty
 *   npx tsx src/db/seed.ts --force  # wipe + reseed
 *
 * All demo accounts share the password: demo1234
 */
import { getDbFile, getDb, closeDb } from "./client";
import { createRepo } from "./repos";
import { hashPassword } from "@/lib/security";
import { nowMs } from "@/lib/util";

const force = process.argv.includes("--force");
const db = getDb();
const raw = getDbFile();
const repo = createRepo(db);

if (!force && repo.getCustomer("CUST-1001")) {
  console.log("[seed] database already seeded (use --force to reseed).");
  closeDb();
  process.exit(0);
}

const t = nowMs();
const day = 24 * 60 * 60 * 1000;
const pw = hashPassword("demo1234");

const ins = (sql: string, params: unknown[]) => raw.prepare(sql).run(...(params as any[]));

if (force) repo.reset();

// ---- People ---------------------------------------------------------------
const people = [
  { id: "CUST-1001", name: "Jane Doe", email: "jane@example.com", role: "customer" },
  { id: "CUST-1002", name: "Alex Kim", email: "alex@example.com", role: "customer" },
  { id: "CUST-1003", name: "Sam Rivera", email: "sam@example.com", role: "customer" },
  { id: "AGENT-2001", name: "Riley Support", email: "riley@support.example.com", role: "support_agent" },
  { id: "ADMIN-3001", name: "Morgan Admin", email: "admin@example.com", role: "admin" },
] as const;
for (const p of people) {
  repo.createCustomer({ id: p.id, name: p.name, email: p.email, passwordHash: pw, role: p.role as any, createdAt: t - 60 * day });
}

// ---- Orders ---------------------------------------------------------------
type SeedOrder = {
  id: string; customerId: string; status: any; total: number; currency: string;
  items: any[]; address: any; trackingNumber: string | null; createdAt: number;
  deliveredAt: number | null; refundableAmount: number;
};

const addr = (city: string, line1: string) => ({
  line1, city, state: "CA", postalCode: "94107", country: "United States",
});

const orders: SeedOrder[] = [
  // Jane - oldest, fully refunded (demonstrates non-refundable / audit history)
  {
    id: "ORD-1003", customerId: "CUST-1001", status: "refunded", total: 8999, currency: "USD",
    items: [{ name: "Wireless Mouse", qty: 1, priceCents: 3999 }, { name: "USB-C Hub", qty: 1, priceCents: 5000 }],
    address: addr("San Francisco", "1 Infinite Loop"), trackingNumber: "TRK-1003-1",
    createdAt: t - 20 * day, deliveredAt: t - 15 * day, refundableAmount: 0,
  },
  // Jane - shipped / in transit (used for "where is order ORD-1001")
  {
    id: "ORD-1001", customerId: "CUST-1001", status: "shipped", total: 8999, currency: "USD",
    items: [{ name: "Mechanical Keyboard", qty: 1, priceCents: 8999 }],
    address: addr("San Francisco", "1 Infinite Loop"), trackingNumber: "TRK-1001-1",
    createdAt: t - 6 * day, deliveredAt: null, refundableAmount: 0,
  },
  // Jane - delivered & fully refundable (used for "refund my last order") - MOST RECENT
  {
    id: "ORD-1002", customerId: "CUST-1001", status: "delivered", total: 12000, currency: "USD",
    items: [{ name: "Standing Desk Mat", qty: 1, priceCents: 12000 }],
    address: addr("San Francisco", "1 Infinite Loop"), trackingNumber: "TRK-1002-1",
    createdAt: t - 3 * day, deliveredAt: t - 1 * day, refundableAmount: 12000,
  },
  // Alex - a delivered order
  {
    id: "ORD-2001", customerId: "CUST-1002", status: "shipped", total: 4300, currency: "USD",
    items: [{ name: "Laptop Sleeve", qty: 1, priceCents: 4300 }],
    address: addr("Oakland", "500 3rd St"), trackingNumber: "TRK-2001-1",
    createdAt: t - 4 * day, deliveredAt: null, refundableAmount: 0,
  },
  // Alex - the cross-customer order Jane must NOT be able to see
  {
    id: "ORD-9999", customerId: "CUST-1002", status: "delivered", total: 2500, currency: "USD",
    items: [{ name: "Cable Kit", qty: 1, priceCents: 2500 }],
    address: addr("Oakland", "500 3rd St"), trackingNumber: "TRK-9999-1",
    createdAt: t - 2 * day, deliveredAt: t - 1 * day, refundableAmount: 0,
  },
  // Sam - delivered & refundable
  {
    id: "ORD-3001", customerId: "CUST-1003", status: "delivered", total: 1500, currency: "USD",
    items: [{ name: "Notebook Set", qty: 3, priceCents: 500 }],
    address: addr("Berkeley", "900 Broadway"), trackingNumber: "TRK-3001-1",
    createdAt: t - 5 * day, deliveredAt: t - 3 * day, refundableAmount: 1500,
  },
];
for (const o of orders) {
  ins("INSERT INTO orders (id, customer_id, status, total, currency, items, shipping_address, tracking_number, created_at, delivered_at, refundable_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [o.id, o.customerId, o.status, o.total, o.currency, JSON.stringify(o.items), JSON.stringify(o.address), o.trackingNumber, o.createdAt, o.deliveredAt, o.refundableAmount]);
}

// ---- A completed, approved refund (for ORD-1003) so admin views have history
ins("INSERT INTO approval_requests (id, requested_by, actor_role, action_type, tool_name, arguments, risk_level, status, approved_by, rejection_reason, order_id, amount_cents, idempotency_key, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ["APR-1001", "CUST-1001", "customer", "refund", "process_refund",
    JSON.stringify({ orderId: "ORD-1003", amount: 8999, reason: "Returned unused item", customerId: "CUST-1001" }),
    "high", "approved", "ADMIN-3001", null, "ORD-1003", 8999,
    "refund:CUST-1001:ORD-1003:APR-1001", t - 14 * day, t - 14 * day + 3600000]);
ins("INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, approval_id, idempotency_key, created_at, processed_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ["REF-1001", "ORD-1003", "CUST-1001", 8999, "Returned unused item", "completed", "APR-1001",
    "refund:CUST-1001:ORD-1003:APR-1001", t - 14 * day, t - 14 * day + 3600000]);
// audit trail for that completed refund
ins("INSERT INTO audit_logs (actor_id, actor_role, action, tool_name, arguments, result, approval_id, conversation_id, timestamp) VALUES (?,?,?,?,?,?,?,?,?)",
  ["CUST-1001", "customer", "refund.requested", "request_refund",
    JSON.stringify({ orderId: "ORD-1003", amount: 8999 }), JSON.stringify({ approvalId: "APR-1001" }), "APR-1001", null, t - 14 * day]);
ins("INSERT INTO audit_logs (actor_id, actor_role, action, tool_name, arguments, result, approval_id, conversation_id, timestamp) VALUES (?,?,?,?,?,?,?,?,?)",
  ["ADMIN-3001", "admin", "approval.approved", "process_refund",
    JSON.stringify({ orderId: "ORD-1003", amount: 8999 }), JSON.stringify({ approved: true }), "APR-1001", null, t - 14 * day + 3000000]);
ins("INSERT INTO audit_logs (actor_id, actor_role, action, tool_name, arguments, result, approval_id, conversation_id, timestamp) VALUES (?,?,?,?,?,?,?,?,?)",
  ["ADMIN-3001", "admin", "refund.completed", "process_refund",
    JSON.stringify({ orderId: "ORD-1003", amount: 8999 }), JSON.stringify({ refundId: "REF-1001" }), "APR-1001", null, t - 14 * day + 3600000]);

// ---- A sample open support ticket for Jane
ins("INSERT INTO support_tickets (id, customer_id, order_id, subject, description, priority, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ["TCK-1001", "CUST-1001", "ORD-1003", "Return label needed",
    "I would like a prepaid return label for my wireless mouse order.", "medium", "open", t - 13 * day, t - 13 * day]);

const counts = repo.countAll();
console.log("[seed] complete:", JSON.stringify(counts));
console.log("[seed] demo login for every account: <email> / demo1234");
console.log("[seed]   customer:  jane@example.com");
console.log("[seed]   customer:  alex@example.com");
console.log("[seed]   customer:  sam@example.com");
console.log("[seed]   support:   riley@support.example.com");
console.log("[seed]   admin:     admin@example.com");
closeDb();
