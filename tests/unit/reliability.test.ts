import { describe, it, expect, vi } from "vitest";
import { withRetry, ProviderHttpError } from "@/lib/retry";
import {
  allowRequest,
  recordLlmDailyCost,
  llmDailyCostTodayCents,
  llmDailyCostExceeded,
} from "@/lib/rate-limit";
import {
  rateLimitMsgPerHour,
  rateLimitRefundPerDay,
  rateLimitApiPerMin,
  rateLimitProvider,
  llmDailyCostCents,
} from "@/lib/env";
import { createStripeRefund } from "@/lib/stripe";
import { resolveTracking, clearTrackingCache } from "@/lib/tracking";
import { createMemoryJobQueue, setJobQueueForTesting } from "@/lib/queue";
import { registerStripeConsistencyJob } from "@/lib/stripe-consistency";
import { notifyEvent, resetNotifyHandlerForTesting } from "@/lib/notify";
import { runTool, ticketIdempotencyKey } from "@/lib/tools";
import { createAgent } from "@/lib/agent";
import { createMockLlm } from "@/lib/mock";
import { makeEnv, principal } from "../helpers";

const jsonResp = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("withRetry (blueprint §8.3)", () => {
  it("retries transient failures with exponential backoff and succeeds", async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new ProviderHttpError(503, "unavailable");
      return "ok";
    }, { label: "test", backoffMs: 1 });
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry permanent 4xx (auth/validation) errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new ProviderHttpError(401, "bad key");
        },
        { label: "test", backoffMs: 1 },
      ),
    ).rejects.toThrow("bad key");
    expect(calls).toBe(1);
  });

  it("throws the last error after max retries are exhausted", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new ProviderHttpError(500, "down");
        },
        { label: "test", backoffMs: 1, maxRetries: 2 },
      ),
    ).rejects.toThrow("down");
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it("treats network/timeout errors as transient", async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls += 1;
      if (calls === 1) throw new Error("fetch failed");
      return "recovered";
    }, { label: "test", backoffMs: 1 });
    expect(out).toBe("recovered");
    expect(calls).toBe(2);
  });
});

describe("Stripe provider retries (blueprint §8.1/§8.3)", () => {
  it("retries a 5xx and succeeds on the next attempt (idempotent key reused)", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    vi.stubEnv("PROVIDER_RETRY_BACKOFF_MS", "1");
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResp(500, { error: "down" }))
      .mockResolvedValueOnce(jsonResp(200, { id: "re_1", status: "succeeded" }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await createStripeRefund({
      paymentIntentId: "pi_1",
      amountCents: 100,
      currency: "usd",
      idempotencyKey: "refund:k1",
    });
    expect(r.id).toBe("re_1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [u1, i1] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const [u2, i2] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(u1).toBe(u2);
    expect((i1.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      (i2.headers as Record<string, string>)["Idempotency-Key"],
    );
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("fails fast on 4xx without retrying", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    const fetchSpy = vi.fn().mockResolvedValue(jsonResp(400, { error: "invalid" }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      createStripeRefund({ paymentIntentId: "pi_1", amountCents: 100, currency: "usd", idempotencyKey: "refund:k2" }),
    ).rejects.toThrow("HTTP 400");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe("EasyPost provider retries + fallback (blueprint §8.1)", () => {
  it("falls back to mock tracking when the carrier keeps returning 404 (no retries)", async () => {
    const env = makeEnv();
    vi.stubEnv("EASYPOST_API_KEY", "ep_test");
    vi.stubEnv("TRACKING_PROVIDER", "easypost");
    vi.stubEnv("PROVIDER_RETRY_BACKOFF_MS", "1");
    const fetchSpy = vi.fn().mockResolvedValue(jsonResp(404, {}));
    vi.stubGlobal("fetch", fetchSpy);
    clearTrackingCache();
    const order = (await env.repo.getOrder("ORD-2"))!;
    const res = await resolveTracking(order);
    expect(res.source).toBe("mock");
    expect(fetchSpy).toHaveBeenCalledTimes(1); // 404 is permanent -> no retry
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearTrackingCache();
  });

  it("recovers from a transient 503 via retry (no fallback needed)", async () => {
    const env = makeEnv();
    vi.stubEnv("EASYPOST_API_KEY", "ep_test");
    vi.stubEnv("TRACKING_PROVIDER", "easypost");
    vi.stubEnv("PROVIDER_RETRY_BACKOFF_MS", "1");
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResp(503, {}))
      .mockResolvedValueOnce(
        jsonResp(200, {
          tracking: {
            status: "DELIVERED",
            carrier: "UPS",
            estimated_delivery_date: null,
            tracking_history: [{ description: "Delivered", status_date: "2026-09-20T12:00:00Z", destination_city: "SF" }],
          },
        }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    clearTrackingCache();
    const order = (await env.repo.getOrder("ORD-1"))!;
    const res = await resolveTracking(order);
    expect(res.source).toBe("easypost");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearTrackingCache();
  });
});

describe("rate limits (blueprint §7.6)", () => {
  it("uses the blueprint defaults when env is unset", () => {
    expect(rateLimitMsgPerHour()).toBe(20);
    expect(rateLimitRefundPerDay()).toBe(5);
    expect(rateLimitApiPerMin()).toBe(100);
    expect(rateLimitProvider()).toBe("memory");
    expect(llmDailyCostCents()).toBe(5000);
  });

  it("enforces the per-customer hourly message cap (21st rejected)", () => {
    for (let i = 0; i < 20; i++) {
      expect(allowRequest("msg:c1", rateLimitMsgPerHour(), 3600_000)).toBe(true);
    }
    expect(allowRequest("msg:c1", rateLimitMsgPerHour(), 3600_000)).toBe(false);
    // A different customer is unaffected.
    expect(allowRequest("msg:c2", rateLimitMsgPerHour(), 3600_000)).toBe(true);
  });

  it("enforces the per-customer daily refund cap (6th rejected)", () => {
    for (let i = 0; i < 5; i++) {
      expect(allowRequest("refund:c1", rateLimitRefundPerDay(), 86_400_000)).toBe(true);
    }
    expect(allowRequest("refund:c1", rateLimitRefundPerDay(), 86_400_000)).toBe(false);
  });

  it("enforces the per-IP per-minute API cap (101st rejected)", () => {
    for (let i = 0; i < 100; i++) {
      expect(allowRequest("api:1.2.3.4", rateLimitApiPerMin(), 60_000)).toBe(true);
    }
    expect(allowRequest("api:1.2.3.4", rateLimitApiPerMin(), 60_000)).toBe(false);
    expect(allowRequest("api:5.6.7.8", rateLimitApiPerMin(), 60_000)).toBe(true);
  });
});

describe("LLM daily spend guard (blueprint §7.6)", () => {
  it("rejects only when the daily cumulative cost strictly exceeds the cap", () => {
    recordLlmDailyCost("CUST-1", 5000);
    expect(llmDailyCostTodayCents("CUST-1")).toBe(5000);
    expect(llmDailyCostExceeded("CUST-1")).toBe(false); // at cap, not over
    recordLlmDailyCost("CUST-1", 1);
    expect(llmDailyCostExceeded("CUST-1")).toBe(true); // 5001 > 5000
    // Other customers are unaffected.
    expect(llmDailyCostExceeded("CUST-2")).toBe(false);
  });

  it("honors the LLM_DAILY_COST_CENTS override", () => {
    vi.stubEnv("LLM_DAILY_COST_CENTS", "100");
    recordLlmDailyCost("CUST-1", 101);
    expect(llmDailyCostExceeded("CUST-1")).toBe(true);
    vi.unstubAllEnvs();
  });

  it("agent turns expose llmCostCents for the guard", async () => {
    const env = makeEnv();
    const agent = createAgent(env.repo, createMockLlm());
    const res = await agent.runTurn({ principal: principal("CUST-1"), userText: "How do I return an item?" });
    expect(typeof res.llmCostCents).toBe("number");
  });
});

describe("ticket creation idempotency (blueprint §8.2)", () => {
  it("same request returns the same ticket; different request creates a new one", async () => {
    const env = makeEnv();
    const ctx = { repo: env.repo, auditor: env.auditor, principal: principal("CUST-1"), conversationId: null };
    const args = {
      orderId: "ORD-1",
      subject: "Missing item",
      description: "My keyboard box was missing a keycap",
      priority: "medium",
    };
    const a = await runTool(ctx, "create_support_ticket", args);
    const b = await runTool(ctx, "create_support_ticket", args);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const ta = (a.ok ? (a.data as any).ticket : null) as any;
    const tb = (b.ok ? (b.data as any).ticket : null) as any;
    expect(tb.id).toBe(ta.id);
    expect((b as any).data.idempotent).toBe(true);
    // Different request -> new ticket.
    const c = await runTool(ctx, "create_support_ticket", { ...args, subject: "Something entirely different" });
    expect((c.ok ? (c.data as any).ticket : null)!.id).not.toBe(ta.id);
    expect(await env.repo.getTicketsByCustomer("CUST-1")).toHaveLength(2);
  });

  it("key normalization ignores case/whitespace but respects fields", () => {
    const base = { customerId: "CUST-1", orderId: "ORD-1", subject: "Missing Item", description: "  no keycap  ", priority: "medium" };
    const same = { ...base, subject: "missing item", description: "no keycap" };
    expect(ticketIdempotencyKey(same)).toBe(ticketIdempotencyKey(base));
    expect(ticketIdempotencyKey({ ...base, orderId: "ORD-2" })).not.toBe(ticketIdempotencyKey(base));
    expect(ticketIdempotencyKey({ ...base, customerId: "CUST-2" })).not.toBe(ticketIdempotencyKey(base));
  });
});

describe("refund daily cap via tool (blueprint §7.6)", () => {
  it("the 6th new refund request for a customer that day is rejected", async () => {
    const env = makeEnv();
    // Pre-consume the 5 daily slots for CUST-1.
    for (let i = 0; i < rateLimitRefundPerDay(); i++) {
      allowRequest("refund:CUST-1", rateLimitRefundPerDay(), 86_400_000);
    }
    const ctx = { repo: env.repo, auditor: env.auditor, principal: principal("CUST-1"), conversationId: null };
    const r = await runTool(ctx, "request_refund", { orderId: "ORD-1", reason: "damaged on arrival" });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe("RATE_LIMITED");
    // Nothing was created.
    expect(await env.repo.getRefundsByOrder("ORD-1")).toHaveLength(0);
    const actions = env.raw.prepare("SELECT action FROM audit_logs").all().map((x: any) => x.action);
    expect(actions).toContain("refund.rate_limited");
  });
});

describe("email idempotency by email id (blueprint §8.2)", () => {
  it("re-enqueued identical emails are never sent twice", async () => {
    const env = makeEnv();
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("RESEND_API_BASE", "https://resend.test");
    const fetchSpy = vi.fn().mockResolvedValue(jsonResp(200, { id: "em_1" }));
    vi.stubGlobal("fetch", fetchSpy);

    const q = createMemoryJobQueue({ ctx: () => ({ repo: env.repo, auditor: env.auditor }) });
    setJobQueueForTesting(q);
    resetNotifyHandlerForTesting();

    const payload = { ticketId: "TCK-DUP", customerId: "CUST-1", subject: "Hi" };
    notifyEvent("ticket_created", payload);
    notifyEvent("ticket_created", payload); // same email id, possibly double-enqueued
    await new Promise((r) => setTimeout(r, 0));
    await q.processNow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // A later re-enqueue (e.g. after a worker restart) still does not resend.
    notifyEvent("ticket_created", payload);
    await new Promise((r) => setTimeout(r, 0));
    await q.processNow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    setJobQueueForTesting(undefined);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe("Stripe consistency check (blueprint §8.5)", () => {
  it("marks completed refunds missing in Stripe as orphaned; keeps matching ones", async () => {
    const env = makeEnv();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/refunds/re_missing")) return jsonResp(404, {});
      return jsonResp(200, { id: "re_found", status: "succeeded" });
    });
    vi.stubGlobal("fetch", fetchSpy);

    // Two settled refunds carrying provider ids.
    const t = Date.now();
    await env.repo.createRefund({
      id: "REF-C1", orderId: "ORD-1", customerId: "CUST-1", amount: 1000,
      reason: "damaged", status: "completed", approvalId: null, idempotencyKey: null,
      createdAt: t, processedAt: t,
    });
    await env.repo.updateRefund("REF-C1", { providerRefundId: "re_missing" });
    await env.repo.createRefund({
      id: "REF-C2", orderId: "ORD-2", customerId: "CUST-1", amount: 1000,
      reason: "damaged", status: "completed", approvalId: null, idempotencyKey: null,
      createdAt: t, processedAt: t,
    });
    await env.repo.updateRefund("REF-C2", { providerRefundId: "re_found" });

    const q = createMemoryJobQueue({ ctx: () => ({ repo: env.repo, auditor: env.auditor }) });
    registerStripeConsistencyJob(q);
    await q.enqueue("check_stripe_consistency", { month: 0 }, "stripe-consistency:test");
    await q.processNow();

    expect((await env.repo.getRefund("REF-C1"))!.status).toBe("orphaned");
    expect((await env.repo.getRefund("REF-C2"))!.status).toBe("completed");
    const actions = env.raw.prepare("SELECT action FROM audit_logs").all().map((x: any) => x.action);
    expect(actions).toContain("refund.orphaned");
    expect(actions).toContain("stripe.consistency_check");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("skips cleanly when no Stripe key is configured", async () => {
    const env = makeEnv();
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const q = createMemoryJobQueue({ ctx: () => ({ repo: env.repo, auditor: env.auditor }) });
    registerStripeConsistencyJob(q);
    await q.enqueue("check_stripe_consistency", {}, "stripe-consistency:skip");
    await q.processNow();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
