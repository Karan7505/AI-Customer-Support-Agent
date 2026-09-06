import { describe, it, expect } from "vitest";
import { GetOrderInput, RequestRefundInput, CreateSupportTicketInput, ProcessRefundInput } from "@/lib/schemas";

describe("Input validation (Zod)", () => {
  it("rejects an invalid order id format", () => {
    const r = GetOrderInput.safeParse({ orderId: "nope" });
    expect(r.success).toBe(false);
  });
  it("accepts a well-formed order id", () => {
    const r = GetOrderInput.safeParse({ orderId: "ORD-1001" });
    expect(r.success).toBe(true);
  });
  it("rejects a negative refund amount", () => {
    const r = RequestRefundInput.safeParse({ orderId: "ORD-1", amount: -500, reason: "broken item" });
    expect(r.success).toBe(false);
  });
  it("rejects a missing refund reason", () => {
    const r = RequestRefundInput.safeParse({ orderId: "ORD-1" });
    expect(r.success).toBe(false);
  });
  it("rejects an unsupported ticket priority", () => {
    const r = CreateSupportTicketInput.safeParse({
      subject: "hi", description: "a problem happened here", priority: "urgent",
    });
    expect(r.success).toBe(false);
  });
  it("rejects a ticket with too-short subject", () => {
    const r = CreateSupportTicketInput.safeParse({ subject: "ab", description: "long enough description", priority: "low" });
    expect(r.success).toBe(false);
  });
  it("rejects unexpected fields (strict schema)", () => {
    const r = GetOrderInput.safeParse({ orderId: "ORD-1", customerId: "CUST-2" });
    expect(r.success).toBe(false);
  });
  it("requires approvalId for process_refund", () => {
    const r = ProcessRefundInput.safeParse({ orderId: "ORD-1", amount: 1000, reason: "x" });
    expect(r.success).toBe(false);
  });
});
