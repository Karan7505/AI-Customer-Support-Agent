import { describe, it, expect } from "vitest";
import { runTool } from "@/lib/tools";
import { makeEnv, principal } from "../helpers";

const ctx = (env: ReturnType<typeof makeEnv>, id = "CUST-1") => ({
  repo: env.repo,
  auditor: env.auditor,
  principal: principal(id, "customer"),
  conversationId: null,
});

describe("Support ticket creation (integration)", () => {
  it("persists a ticket and returns its id", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env), "create_support_ticket", {
      orderId: "ORD-1",
      subject: "Arrived damaged",
      description: "The desk mat arrived with a cracked corner.",
      priority: "high",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const t = (res.data as any).ticket;
      expect(t.id).toMatch(/^TCK-/);
      const stored = env.repo.getTicket(t.id);
      expect(stored).toBeTruthy();
      expect(stored?.customerId).toBe("CUST-1");
      expect(stored?.orderId).toBe("ORD-1");
      expect(stored?.priority).toBe("high");
    }
  });

  it("rejects a ticket referencing another customer's order", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env, "CUST-1"), "create_support_ticket", {
      orderId: "ORD-9999",
      subject: "About a different order",
      description: "This references someone else's order.",
      priority: "low",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });

  it("rejects an invalid priority", async () => {
    const env = makeEnv();
    const res = await runTool(ctx(env), "create_support_ticket", {
      subject: "hi there",
      description: "a real description",
      priority: "asap",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("VALIDATION_ERROR");
  });
});
