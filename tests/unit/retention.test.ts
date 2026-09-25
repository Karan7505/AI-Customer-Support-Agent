import { describe, it, expect } from "vitest";
import { makeEnv, T, DAY } from "../helpers";
import { createMemoryJobQueue } from "@/lib/queue";
import { registerRetentionJob } from "@/lib/retention";

const YEAR = 365 * DAY;

async function runSweep(repo: any, auditor: any) {
  const q = createMemoryJobQueue({ ctx: () => ({ repo, auditor }) });
  registerRetentionJob(q);
  await q.enqueue("retention_cleanup", {}, "retention:test");
  await q.processNow();
}

describe("retention sweep (blueprint §6.6)", () => {
  it("soft-deletes rows past policy, keeps recent rows, audits + tracks the sweep", async () => {
    const env = makeEnv();
    const raw = env.raw;

    // Age CUST-2's data beyond policy: customer >1y, order/ticket/conv/msg >2y.
    raw.prepare("UPDATE customers SET created_at = ? WHERE id = 'CUST-2'").run(T - YEAR - 30 * DAY);
    raw.prepare("UPDATE orders SET created_at = ? WHERE id = 'ORD-9999'").run(T - 2 * YEAR - 30 * DAY);
    raw
      .prepare(
        "INSERT INTO support_tickets (id, customer_id, order_id, subject, description, priority, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run("TCK-OLD", "CUST-2", null, "old", "old", "low", "closed", T - 2 * YEAR - 30 * DAY, T - 2 * YEAR - 30 * DAY);
    raw
      .prepare("INSERT INTO conversations (id, customer_id, title, created_at) VALUES (?,?,?,?)")
      .run("CONV-OLD", "CUST-2", "old", T - 2 * YEAR - 30 * DAY);
    raw
      .prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?,?,?,?)")
      .run("CONV-OLD", "user", "old msg", T - 2 * YEAR - 30 * DAY);
    // A 4-year-old audit row (compliance horizon is 3y) must be hard-deleted.
    await env.repo.addAudit({
      actorId: "CUST-2",
      actorRole: "customer",
      action: "chat.turn",
      status: "success",
      timestamp: T - 4 * YEAR,
    });

    await runSweep(env.repo, env.auditor);

    // Past-policy rows are soft-deleted.
    const deletedAt = (sql: string) => (raw.prepare(sql).get() as any).deleted_at;
    expect(deletedAt("SELECT deleted_at FROM customers WHERE id='CUST-2'")).not.toBeNull();
    expect(deletedAt("SELECT deleted_at FROM orders WHERE id='ORD-9999'")).not.toBeNull();
    expect(deletedAt("SELECT deleted_at FROM support_tickets WHERE id='TCK-OLD'")).not.toBeNull();
    expect(deletedAt("SELECT deleted_at FROM conversations WHERE id='CONV-OLD'")).not.toBeNull();
    expect(deletedAt("SELECT deleted_at FROM messages WHERE conversation_id='CONV-OLD'")).not.toBeNull();
    // Recent rows are untouched.
    expect(deletedAt("SELECT deleted_at FROM customers WHERE id='CUST-1'")).toBeNull();
    expect(deletedAt("SELECT deleted_at FROM orders WHERE id='ORD-1'")).toBeNull();
    // 4y audit row hard-deleted; the sweep's own audit entry exists.
    const oldAudits = (raw.prepare("SELECT COUNT(*) c FROM audit_logs WHERE timestamp < ?").get(T - 3 * YEAR - 10 * DAY) as any).c;
    expect(oldAudits).toBe(0);
    const actions = raw.prepare("SELECT action FROM audit_logs").all().map((r: any) => r.action);
    expect(actions).toContain("retention.cleanup");
    // Policy tracking updated.
    const pol = raw.prepare("SELECT retention_days, last_cleanup FROM data_retention_policy WHERE table_name='customers'").get() as any;
    expect(pol.retention_days).toBe(365);
    expect(pol.last_cleanup).toBeGreaterThan(0);
  });

  it("honors the DATA_RETENTION_CUSTOMER_YEARS override", async () => {
    const env = makeEnv();
    const raw = env.raw;
    // 18 months old: within the default 1y? No — beyond 1y, within 2y.
    raw.prepare("UPDATE customers SET created_at = ? WHERE id = 'CUST-2'").run(T - Math.round(1.5 * YEAR));
    process.env.DATA_RETENTION_CUSTOMER_YEARS = "2";
    try {
      await runSweep(env.repo, env.auditor);
      expect((raw.prepare("SELECT deleted_at FROM customers WHERE id='CUST-2'").get() as any).deleted_at).toBeNull();
    } finally {
      delete process.env.DATA_RETENTION_CUSTOMER_YEARS;
    }
  });

  it("retains refunds forever (financial records)", async () => {
    const env = makeEnv();
    const t = T - 4 * YEAR;
    await env.repo.createRefund({
      id: "REF-OLD", orderId: "ORD-1", customerId: "CUST-1", amount: 5000,
      reason: "old", status: "completed", approvalId: null, idempotencyKey: null,
      createdAt: t, processedAt: t,
    });
    await runSweep(env.repo, env.auditor);
    expect(await env.repo.getRefund("REF-OLD")).toBeDefined();
  });
});

describe("customer data erasure (blueprint §6.6)", () => {
  it("softDeleteCustomerData erases erasable data, keeps refunds, hides it from read paths", async () => {
    const env = makeEnv();
    const t = T - 10 * DAY;
    await env.repo.createRefund({
      id: "REF-2", orderId: "ORD-9999", customerId: "CUST-2", amount: 1000,
      reason: "r", status: "completed", approvalId: null, idempotencyKey: null,
      createdAt: t, processedAt: t,
    });
    await env.repo.createTicket({
      id: "TCK-2", customerId: "CUST-2", orderId: null, subject: "s", description: "d",
      priority: "low", status: "open", internalNotes: null, idempotencyKey: null, createdAt: t, updatedAt: t,
    });
    const conv = await env.repo.getOrCreateConversation("CUST-2");
    await env.repo.addMessage({ conversationId: conv.id, role: "user", content: "hi", createdAt: t });

    const counts = await env.repo.softDeleteCustomerData("CUST-2");
    expect(counts).toEqual({ customers: 1, orders: 1, support_tickets: 1, conversations: 1, messages: 1 });

    // Read paths hide the soft-deleted data.
    expect(await env.repo.getCustomer("CUST-2")).toBeUndefined();
    expect(await env.repo.getOrder("ORD-9999")).toBeUndefined();
    expect(await env.repo.searchOrders({ customerId: "CUST-2" })).toEqual([]);
    expect(await env.repo.getTicketsByCustomer("CUST-2")).toEqual([]);
    expect(await env.repo.listConversations("CUST-2")).toEqual([]);
    expect(await env.repo.listMessages(conv.id)).toEqual([]);

    // Refunds are retained forever; other customers are unaffected.
    expect(await env.repo.getRefund("REF-2")).toBeDefined();
    expect(await env.repo.getCustomer("CUST-1")).toBeDefined();
  });
});
