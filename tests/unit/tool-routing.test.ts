import { describe, it, expect } from "vitest";
import { getToolSpec, runTool, visibleToolNames } from "@/lib/tools";
import { makeEnv, principal } from "../helpers";

const ctx = (env: ReturnType<typeof makeEnv>, id = "CUST-1") => ({
  repo: env.repo,
  auditor: env.auditor,
  principal: principal(id, "customer"),
  conversationId: null,
});

describe("Tool routing", () => {
  it("rejects unknown tools", async () => {
    const env = makeEnv();
    await expect(runTool(ctx(env), "drop_database", {})).rejects.toThrow(/Unknown or internal tool/);
  });
  it("rejects the internal process_refund tool when called directly", async () => {
    const env = makeEnv();
    await expect(
      runTool(ctx(env, "ADMIN-1"), "process_refund", { orderId: "ORD-1", amount: 1000, reason: "x", approvalId: "APR-1" }),
    ).rejects.toThrow(/internal/);
  });
  it("never exposes process_refund in the visible tool list", () => {
    expect(visibleToolNames("admin")).not.toContain("process_refund");
    expect(getToolSpec("process_refund")).toBeUndefined();
  });
  it("request_refund creates an approval, not a completed refund", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env), "request_refund", { orderId: "ORD-1", amount: 4000, reason: "damaged on arrival" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as any).status).toBe("pending_approval");
      expect((res.data as any).approvalId).toMatch(/^APR-/);
    }
    // No completed refund exists yet.
    const refunds = env.repo.getRefundsByOrder("ORD-1");
    expect(refunds.filter((r) => r.status === "completed")).toHaveLength(0);
  });
});
