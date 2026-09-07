/**
 * Seed realistic demo data so the app is demonstrable without manual entry.
 *   npx tsx src/db/seed.ts          # seed if empty
 *   npx tsx src/db/seed.ts --force  # wipe + reseed
 *
 * Driver-agnostic: uses the active Repo (SQLite by default, or Supabase/Postgres
 * when DATABASE_URL is set). All demo accounts share the password: demo1234
 */
import { getRepo, type Repo } from "./repos";
import { logRuntimeMode } from "@/lib/env";
import { hashPassword } from "@/lib/security";
import { nowMs } from "@/lib/util";

const force = process.argv.includes("--force");

async function seed(repo: Repo) {
  logRuntimeMode();
  const t = nowMs();
  const day = 24 * 60 * 60 * 1000;
  const pw = hashPassword("demo1234");

  if (!force && (await repo.getCustomer("CUST-1001"))) {
    console.log("[seed] database already seeded (use --force to reseed).");
    return;
  }
  if (force) await repo.reset();

  // ---- People -------------------------------------------------------------
  const people = [
    { id: "CUST-1001", name: "Jane Doe", email: "jane@example.com", role: "customer" },
    { id: "CUST-1002", name: "Alex Kim", email: "alex@example.com", role: "customer" },
    { id: "CUST-1003", name: "Sam Rivera", email: "sam@example.com", role: "customer" },
    { id: "AGENT-2001", name: "Riley Support", email: "riley@support.example.com", role: "support_agent" },
    { id: "ADMIN-3001", name: "Morgan Admin", email: "admin@example.com", role: "admin" },
  ];
  for (const p of people) {
    await repo.createCustomer({ id: p.id, name: p.name, email: p.email, passwordHash: pw, role: p.role, createdAt: t - 60 * day });
  }

  // ---- Orders -------------------------------------------------------------
  const addr = (city: string, line1: string) => ({ line1, city, state: "CA", postalCode: "94107", country: "United States" });
  const orders = [
    // Jane - oldest, fully refunded (demonstrates non-refundable / audit history)
    { id: "ORD-1003", customerId: "CUST-1001", status: "refunded", total: 8999, currency: "USD",
      items: [{ name: "Wireless Mouse", qty: 1, priceCents: 3999 }, { name: "USB-C Hub", qty: 1, priceCents: 5000 }],
      address: addr("San Francisco", "1 Infinite Loop"), trackingNumber: "TRK-1003-1",
      createdAt: t - 20 * day, deliveredAt: t - 15 * day, refundableAmount: 0 },
    // Jane - shipped / in transit (used for "where is order ORD-1001")
    { id: "ORD-1001", customerId: "CUST-1001", status: "shipped", total: 8999, currency: "USD",
      items: [{ name: "Mechanical Keyboard", qty: 1, priceCents: 8999 }],
      address: addr("San Francisco", "1 Infinite Loop"), trackingNumber: "TRK-1001-1",
      createdAt: t - 6 * day, deliveredAt: null, refundableAmount: 0 },
    // Jane - delivered & fully refundable (used for "refund my last order") - MOST RECENT
    { id: "ORD-1002", customerId: "CUST-1001", status: "delivered", total: 12000, currency: "USD",
      items: [{ name: "Standing Desk Mat", qty: 1, priceCents: 12000 }],
      address: addr("San Francisco", "1 Infinite Loop"), trackingNumber: "TRK-1002-1",
      createdAt: t - 3 * day, deliveredAt: t - 1 * day, refundableAmount: 12000 },
    // Alex - a shipped order
    { id: "ORD-2001", customerId: "CUST-1002", status: "shipped", total: 4300, currency: "USD",
      items: [{ name: "Laptop Sleeve", qty: 1, priceCents: 4300 }],
      address: addr("Oakland", "500 3rd St"), trackingNumber: "TRK-2001-1",
      createdAt: t - 4 * day, deliveredAt: null, refundableAmount: 0 },
    // Alex - the cross-customer order Jane must NOT be able to see
    { id: "ORD-9999", customerId: "CUST-1002", status: "delivered", total: 2500, currency: "USD",
      items: [{ name: "Cable Kit", qty: 1, priceCents: 2500 }],
      address: addr("Oakland", "500 3rd St"), trackingNumber: "TRK-9999-1",
      createdAt: t - 2 * day, deliveredAt: t - 1 * day, refundableAmount: 0 },
    // Sam - delivered & refundable
    { id: "ORD-3001", customerId: "CUST-1003", status: "delivered", total: 1500, currency: "USD",
      items: [{ name: "Notebook Set", qty: 3, priceCents: 500 }],
      address: addr("Berkeley", "900 Broadway"), trackingNumber: "TRK-3001-1",
      createdAt: t - 5 * day, deliveredAt: t - 3 * day, refundableAmount: 1500 },
  ];
  for (const o of orders) {
    await repo.createOrder({
      id: o.id, customerId: o.customerId, status: o.status, total: o.total, currency: o.currency,
      items: JSON.stringify(o.items), shippingAddress: JSON.stringify(o.address), trackingNumber: o.trackingNumber,
      createdAt: o.createdAt, deliveredAt: o.deliveredAt, refundableAmount: o.refundableAmount,
    });
  }

  // ---- A completed, approved refund (for ORD-1003) so admin views have history
  await repo.createApproval({
    id: "APR-1001", requestedBy: "CUST-1001", actorRole: "customer", actionType: "refund", toolName: "process_refund",
    arguments: JSON.stringify({ orderId: "ORD-1003", amount: 8999, reason: "Returned unused item", customerId: "CUST-1001" }),
    riskLevel: "high", status: "approved", orderId: "ORD-1003", amountCents: 8999,
    idempotencyKey: "refund:CUST-1001:ORD-1003:APR-1001", createdAt: t - 14 * day,
  });
  // update the approval's resolved/approved fields (created via createApproval default)
  await repo.updateApproval("APR-1001", { status: "approved", approvedBy: "ADMIN-3001", resolvedAt: t - 14 * day + 3600000 });
  await repo.createRefund({
    id: "REF-1001", orderId: "ORD-1003", customerId: "CUST-1001", amount: 8999, reason: "Returned unused item",
    status: "completed", approvalId: "APR-1001", idempotencyKey: "refund:CUST-1001:ORD-1003:APR-1001",
    createdAt: t - 14 * day, processedAt: t - 14 * day + 3600000,
  });
  await repo.addAudit({ actorId: "CUST-1001", actorRole: "customer", action: "refund.requested", toolName: "request_refund", arguments: { orderId: "ORD-1003", amount: 8999 }, result: { approvalId: "APR-1001" }, approvalId: "APR-1001", timestamp: t - 14 * day });
  await repo.addAudit({ actorId: "ADMIN-3001", actorRole: "admin", action: "approval.approved", toolName: "process_refund", arguments: { orderId: "ORD-1003", amount: 8999 }, result: { approved: true }, approvalId: "APR-1001", timestamp: t - 14 * day + 3000000 });
  await repo.addAudit({ actorId: "ADMIN-3001", actorRole: "admin", action: "refund.completed", toolName: "process_refund", arguments: { orderId: "ORD-1003", amount: 8999 }, result: { refundId: "REF-1001" }, approvalId: "APR-1001", timestamp: t - 14 * day + 3600000 });

  // ---- A sample open support ticket for Jane
  await repo.createTicket({
    id: "TCK-1001", customerId: "CUST-1001", orderId: "ORD-1003", subject: "Return label needed",
    description: "I would like a prepaid return label for my wireless mouse order.",
    priority: "medium", status: "open", internalNotes: null, createdAt: t - 13 * day, updatedAt: t - 13 * day,
  });

  const counts = await repo.countAll();
  console.log("[seed] complete:", JSON.stringify(counts));
  console.log("[seed] demo login for every account: <email> / demo1234");
  console.log("[seed]   customer:  jane@example.com");
  console.log("[seed]   customer:  alex@example.com");
  console.log("[seed]   customer:  sam@example.com");
  console.log("[seed]   support:   riley@support.example.com");
  console.log("[seed]   admin:     admin@example.com");
}

seed(getRepo())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[seed] failed:", e);
    process.exit(1);
  });
