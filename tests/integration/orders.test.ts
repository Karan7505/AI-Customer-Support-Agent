import { describe, it, expect } from "vitest";
import { runTool } from "@/lib/tools";
import { makeEnv, principal } from "../helpers";

const ctx = (env: ReturnType<typeof makeEnv>, id = "CUST-1") => ({
  repo: env.repo,
  auditor: env.auditor,
  principal: principal(id, "customer"),
  conversationId: null,
});

describe("Order lookup (integration)", () => {
  it("returns an owned order", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env), "get_order", { orderId: "ORD-1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as any).order.id).toBe("ORD-1");
  });

  it("returns NOT_FOUND for a non-existent order", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env), "get_order", { orderId: "ORD-404" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });

  it("blocks cross-customer access with NOT_FOUND (no data leakage)", async () => {
    const env = makeEnv();
    // ORD-9999 belongs to CUST-2; CUST-1 must not see it.
    const res = await runTool(ctx(env, "CUST-1"), "get_order", { orderId: "ORD-9999" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("NOT_FOUND");
      // No PII of the other customer leaks.
      expect(JSON.stringify(res.error)).not.toContain("CUST-2");
    }
  });

  it("only lists the authenticated customer's orders", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env, "CUST-1"), "list_customer_orders", {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      const ids = (res.data as any).orders.map((o: any) => o.id);
      expect(ids).toContain("ORD-1");
      expect(ids).not.toContain("ORD-9999");
    }
  });

  it("returns realistic tracking for a shipped order", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env), "get_tracking_status", { orderId: "ORD-2" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const t = (res.data as any).tracking;
      expect(Array.isArray(t.events)).toBe(true);
      expect(t.events.length).toBeGreaterThan(0);
    }
  });
});
