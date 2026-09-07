import { describe, it, expect } from "vitest";
import { createAgent } from "@/lib/agent";
import { createMockLlm } from "@/lib/mock";
import { makeEnv, principal } from "../helpers";
import type { TestEnv } from "../helpers";

/**
 * Regression coverage for: "admin clicks Chat and nothing happens."
 * The agent must be fully usable by staff (admin/support), not just customers:
 *  - staff can search customers, view ANY customer's orders/tickets,
 *  - staff can file/update tickets on a customer's behalf,
 *  - staff can initiate a refund FOR a customer (creates an approval keyed to
 *    the target customer - not the staff member).
 *  - customers are still locked to their own account.
 *
 * Fixture (see tests/helpers.ts): CUST-1 "Jane", CUST-2 "Alex" (owns ORD-9999,
 * already fully refunded), ORD-1 (Jane, delivered, $120 refundable).
 */

function agentFor(env: TestEnv) {
  return createAgent(env.repo, createMockLlm());
}
const admin = () => principal("ADMIN-1", "admin");
const customer = () => principal("CUST-1", "customer");

describe("Staff (admin/support) chat", () => {
  it("admin can search a customer", async () => {
    const env = makeEnv();
    const res = await agentFor(env).runTurn({ principal: admin(), userText: "Who is the customer Jane?" });
    expect(res.assistantText).toMatch(/Jane/i);
    expect(res.assistantText).toMatch(/jane@t\.com/i);
  });

  it("admin can view another customer's order (no NOT_FOUND)", async () => {
    const env = makeEnv();
    // ORD-9999 belongs to CUST-2 (Alex). An admin may view it.
    const res = await agentFor(env).runTurn({ principal: admin(), userText: "Check order ORD-9999" });
    expect(res.assistantText).toMatch(/ORD-9999/);
    expect(res.assistantText).not.toMatch(/couldn't find/i);
  });

  it("admin can list orders for a customer", async () => {
    const env = makeEnv();
    const res = await agentFor(env).runTurn({ principal: admin(), userText: "Show all orders for the customer Alex" });
    expect(res.assistantText).toMatch(/ORD-9999/);
    expect(res.assistantText).toMatch(/Alex|CUST-2/);
  });

  it("admin can list tickets", async () => {
    const env = makeEnv();
    await env.repo.createTicket({
      id: "TCK-1", customerId: "CUST-1", orderId: null,
      subject: "Fixture ticket", description: "A pre-existing open ticket.",
      priority: "low", status: "open", internalNotes: null, createdAt: env.now, updatedAt: env.now,
    });
    const res = await agentFor(env).runTurn({ principal: admin(), userText: "List the open tickets" });
    expect(res.assistantText).toMatch(/TCK-1/);
  });

  it("admin can file a ticket on a customer's behalf", async () => {
    const env = makeEnv();
    const before = (await env.repo.listTickets({ limit: 100 })).length;
    const res = await agentFor(env).runTurn({
      principal: admin(),
      userText: "Create a support ticket for the customer Alex: their order arrived damaged",
    });
    expect(res.assistantText).toMatch(/TCK-/i);
    expect((await env.repo.listTickets({ limit: 100 })).length).toBe(before + 1);
    // The new ticket belongs to Alex (CUST-2), not the admin.
    expect((await env.repo.listTickets({ customerId: "CUST-2", limit: 1 })).length).toBeGreaterThan(0);
  });

  it("admin can initiate a refund FOR a customer -> approval keyed to that customer", async () => {
    const env = makeEnv();
    const res = await agentFor(env).runTurn({
      principal: admin(),
      userText: "Refund $50 from order ORD-1 for the customer Jane",
    });
    const s = res.structured as any;
    expect(s?.status).toBe("pending_approval");
    expect(s?.orderId).toBe("ORD-1");
    expect(res.assistantText).toMatch(/approval/i);
    // The pending refund must be attributed to Jane (CUST-1), not the admin.
    const refunds = await env.repo.getRefundsByOrder("ORD-1");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].customerId).toBe("CUST-1");
    expect(refunds[0].status).toBe("pending_approval");
    const approval = (await env.repo.getApproval(refunds[0].approvalId!))!;
    expect(approval.requestedBy).toBe("ADMIN-1"); // the staff member initiated it
    expect(approval.orderId).toBe("ORD-1");
    expect(approval.amountCents).toBe(5000);
  });

  it("a customer still cannot see another customer's orders", async () => {
    const env = makeEnv();
    const res = await agentFor(env).runTurn({
      principal: customer(),
      userText: "Show all orders for the customer Alex",
    });
    expect(res.assistantText).not.toMatch(/ORD-9999/);
    expect(res.assistantText).not.toMatch(/CUST-2/);
  });

  it("a customer cannot request a refund for another customer", async () => {
    const env = makeEnv();
    await agentFor(env).runTurn({
      principal: customer(),
      userText: "Refund $10 from order ORD-9999 for the customer Alex",
    });
    // ORD-9999 is not the customer's, so no refund is created for it.
    expect(await env.repo.getRefundsByOrder("ORD-9999")).toHaveLength(0);
  });
});
