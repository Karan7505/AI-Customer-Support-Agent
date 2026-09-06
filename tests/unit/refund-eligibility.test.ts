import { describe, it, expect } from "vitest";
import { checkRefundEligibility, refundIdempotencyKey, refundRequestKey } from "@/lib/refunds";
import { makeEnv, DAY } from "../helpers";
import type { Order } from "@/lib/types";

function baseOrder(over: Partial<Order>): Order {
  const { repo } = makeEnv();
  const o = repo.getOrder("ORD-1")!;
  return { ...o, ...over };
}

describe("Refund eligibility (deterministic business rules)", () => {
  it("allows a refund within the remaining refundable amount", () => {
    const d = checkRefundEligibility(baseOrder({}), 5000, Date.now());
    expect(d.allowed).toBe(true);
  });
  it("allows a partial refund for a partially_refunded order", () => {
    const d = checkRefundEligibility(baseOrder({ status: "partially_refunded", refundableAmount: 4000 }), 4000, Date.now());
    expect(d.allowed).toBe(true);
  });
  it("rejects a refund that exceeds the remaining refundable amount", () => {
    const d = checkRefundEligibility(baseOrder({ refundableAmount: 4000 }), 10000, Date.now());
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/exceeds/i);
  });
  it("rejects a non-refundable status (shipped)", () => {
    const d = checkRefundEligibility(baseOrder({ status: "shipped", refundableAmount: 100 }), 100, Date.now());
    expect(d.allowed).toBe(false);
  });
  it("rejects an already fully refunded order", () => {
    const d = checkRefundEligibility(baseOrder({ status: "refunded", refundableAmount: 0 }), 100, Date.now());
    expect(d.allowed).toBe(false);
  });
  it("rejects a cancelled order", () => {
    const d = checkRefundEligibility(baseOrder({ status: "cancelled", refundableAmount: 0 }), 100, Date.now());
    expect(d.allowed).toBe(false);
  });
  it("rejects zero / negative amounts", () => {
    expect(checkRefundEligibility(baseOrder({}), 0, Date.now()).allowed).toBe(false);
    expect(checkRefundEligibility(baseOrder({}), -1, Date.now()).allowed).toBe(false);
  });
  it("rejects a full refund outside the delivery window", () => {
    // delivered 45 days ago, request the full amount
    const d = checkRefundEligibility(
      baseOrder({ deliveredAt: Date.now() - 45 * DAY, total: 12000, refundableAmount: 12000 }),
      12000,
      Date.now(),
    );
    expect(d.allowed).toBe(false);
  });
});

describe("Refund idempotency keys", () => {
  it("binds customer + order + approval", () => {
    expect(refundIdempotencyKey({ customerId: "C1", orderId: "O1", approvalId: "A1" }))
      .toBe("refund:C1:O1:A1");
  });
  it("is stable for the same inputs", () => {
    expect(refundRequestKey({ customerId: "C1", orderId: "O1", amountCents: 1000, reason: "Broken" }))
      .toBe(refundRequestKey({ customerId: "C1", orderId: "O1", amountCents: 1000, reason: " broken " }));
  });
});
