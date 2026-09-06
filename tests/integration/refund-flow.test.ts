import { describe, it, expect } from "vitest";
import { runTool } from "@/lib/tools";
import { createApproval, decideApproval, executeApprovedAction, mapApproval } from "@/lib/approvals";
import { Errors } from "@/lib/errors";
import { makeEnv, principal } from "../helpers";
import { refundIdempotencyKey } from "@/lib/refunds";

const ctx = (env: ReturnType<typeof makeEnv>, id = "CUST-1") => ({
  repo: env.repo,
  auditor: env.auditor,
  principal: principal(id, "customer"),
  conversationId: null,
});
const admin = () => principal("ADMIN-1", "admin");

function requestRefund(env: ReturnType<typeof makeEnv>, amount = 4000) {
  return runTool(ctx(env), "request_refund", { orderId: "ORD-1", amount, reason: "damaged on arrival" });
}

describe("Refund request -> approval (integration)", () => {
  it("creates a pending approval and a pending refund (no money moved)", async () => {
    const env = makeEnv();
    const res = await requestRefund(env, 4000);
    expect(res.ok).toBe(true);
    const data = res.ok ? (res.data as any) : null;
    expect(data).not.toBeNull();
    expect(data.status).toBe("pending_approval");
    expect(data.approvalId).toMatch(/^APR-/);

    // The refund record is in pending_approval, NOT completed.
    const refunds = env.repo.getRefundsByOrder("ORD-1");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].status).toBe("pending_approval");
    // Order refundable amount unchanged.
    expect(env.repo.getOrder("ORD-1")!.refundableAmount).toBe(12000);
  });

  it("rejects ineligible orders with a structured error", async () => {
    const env = makeEnv();
    // ORD-2 is shipped (not refundable)
    const res = await runTool(ctx(env), "request_refund", { orderId: "ORD-2", amount: 100, reason: "damaged" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("ELIGIBILITY");
  });

  it("rejects a refund exceeding the remaining refundable amount", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env), "request_refund", { orderId: "ORD-1", amount: 99999, reason: "damaged" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("ELIGIBILITY");
  });

  it("blocks cross-customer refund requests", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env, "CUST-1"), "request_refund", { orderId: "ORD-9999", amount: 100, reason: "damaged" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });

  it("prevents duplicate pending refund submissions", async () => {
    const env = makeEnv();
    const first = await requestRefund(env, 4000);
    expect(first.ok).toBe(true);
    const second = await requestRefund(env, 4000);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("DUPLICATE");
  });
});

describe("Approval decision + execution (integration)", () => {
  it("approve -> executes exactly one completed refund, updates order", async () => {
    const env = makeEnv();
    const req = await requestRefund(env, 5000);
    const approvalId = (req.ok ? (req.data as any).approvalId : "") as string;

    const decided = decideApproval(env.repo, env.auditor, admin(), { approvalId, approve: true });
    expect(decided.status).toBe("approved");

    const { refund } = executeApprovedAction(env.repo, env.auditor, admin(), approvalId);
    expect(refund.status).toBe("completed");
    expect(refund.amount).toBe(5000);

    // Order balance decremented, status flipped to partially_refunded.
    const order = env.repo.getOrder("ORD-1")!;
    expect(order.refundableAmount).toBe(7000);
    expect(order.status).toBe("partially_refunded");

    // Exactly ONE refund for the order.
    expect(env.repo.getRefundsByOrder("ORD-1").length).toBe(1);
  });

  it("reject -> refund is marked rejected and NOT executed", async () => {
    const env = makeEnv();
    const req = await requestRefund(env, 5000);
    const approvalId = (req.ok ? (req.data as any).approvalId : "") as string;

    const decided = decideApproval(env.repo, env.auditor, admin(), { approvalId, approve: false, reason: "Not covered" });
    expect(decided.status).toBe("rejected");

    // Refund record should be updated to rejected; order untouched.
    const refunds = env.repo.getRefundsByOrder("ORD-1");
    expect(refunds[0].status).toBe("rejected");
    expect(env.repo.getOrder("ORD-1")!.refundableAmount).toBe(12000);
    expect(env.repo.getOrder("ORD-1")!.status).toBe("delivered");
  });

  it("a customer cannot approve their own approval", () => {
    const env = makeEnv();
    // Build an approval requested by the customer.
    const ap = createApproval(env.repo, env.auditor, {
      requestedBy: principal("CUST-1", "customer"),
      actionType: "refund",
      toolName: "process_refund",
      arguments: { orderId: "ORD-1", amount: 1000, reason: "x", customerId: "CUST-1" },
      riskLevel: "high",
      orderId: "ORD-1",
      amountCents: 1000,
    });
    expect(() =>
      decideApproval(env.repo, env.auditor, principal("CUST-1", "customer"), {
        approvalId: ap.id,
        approve: true,
      }),
    ).toThrow(/admin/i);
  });

  it("execution is idempotent: the same approved refund runs once", async () => {
    const env = makeEnv();
    const req = await requestRefund(env, 5000);
    const approvalId = (req.ok ? (req.data as any).approvalId : "") as string;
    decideApproval(env.repo, env.auditor, admin(), { approvalId, approve: true });

    const first = executeApprovedAction(env.repo, env.auditor, admin(), approvalId).refund;
    const second = executeApprovedAction(env.repo, env.auditor, admin(), approvalId).refund;

    expect(first.id).toBe(second.id);
    expect(second.status).toBe("completed");
    expect(env.repo.getRefundsByOrder("ORD-1").length).toBe(1);
    // Balance decremented only once.
    expect(env.repo.getOrder("ORD-1")!.refundableAmount).toBe(7000);
  });

  it("cannot execute a rejected approval", async () => {
    const env = makeEnv();
    const req = await requestRefund(env, 5000);
    const approvalId = (req.ok ? (req.data as any).approvalId : "") as string;
    decideApproval(env.repo, env.auditor, admin(), { approvalId, approve: false, reason: "no" });
    expect(() => executeApprovedAction(env.repo, env.auditor, admin(), approvalId)).toThrow(
      /not approved/i,
    );
    expect(env.repo.getRefundsByOrder("ORD-1")[0].status).toBe("rejected");
  });

  it("a full approval bound to exact args cannot be reused for a different payload", async () => {
    const env = makeEnv();
    // Two different refunds (different amounts) get different approvals/keys.
    const r1 = await requestRefund(env, 3000);
    const a1 = (r1.ok ? (r1.data as any).approvalId : "") as string;
    // Mark the first pending refund as completed to allow a second request.
    env.repo.updateRefund(env.repo.getRefundsByOrder("ORD-1")[0].id, { status: "rejected" });

    const r2 = await requestRefund(env, 7000);
    const a2 = (r2.ok ? (r2.data as any).approvalId : "") as string;
    expect(a1).not.toBe(a2);
    // Approving a2 must NOT produce a 3000 refund.
    decideApproval(env.repo, env.auditor, admin(), { approvalId: a2, approve: true });
    const { refund } = executeApprovedAction(env.repo, env.auditor, admin(), a2);
    expect(refund.amount).toBe(7000);
  });
});
