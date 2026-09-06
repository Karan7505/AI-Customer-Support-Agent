import { describe, it, expect } from "vitest";
import { canTransition, APPROVAL_TRANSITIONS } from "@/lib/approvals";

describe("Approval state machine", () => {
  it("allows pending -> approved and pending -> rejected", () => {
    expect(canTransition("pending_approval", "approved")).toBe(true);
    expect(canTransition("pending_approval", "rejected")).toBe(true);
  });
  it("allows pending -> expired", () => {
    expect(canTransition("pending_approval", "expired")).toBe(true);
  });
  it("terminal states cannot transition", () => {
    expect(APPROVAL_TRANSITIONS.approved).toEqual([]);
    expect(APPROVAL_TRANSITIONS.rejected).toEqual([]);
    expect(APPROVAL_TRANSITIONS.expired).toEqual([]);
    expect(canTransition("approved", "rejected")).toBe(false);
    expect(canTransition("rejected", "approved")).toBe(false);
  });
  it("cannot re-open a decided approval", () => {
    expect(canTransition("approved", "pending_approval")).toBe(false);
  });
});
