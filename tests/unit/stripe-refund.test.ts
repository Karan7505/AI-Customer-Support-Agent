import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runTool } from "@/lib/tools";
import { createApproval, decideApproval, executeApprovedAction } from "@/lib/approvals";
import { registerStripeJobHandlers } from "@/lib/stripe";
import { createMemoryJobQueue, getJobQueue, setJobQueueForTesting, type JobQueue } from "@/lib/queue";
import { makeEnv, principal } from "../helpers";

const admin = () => principal("ADMIN-1", "admin");

async function requestAndApprove(env: ReturnType<typeof makeEnv>, amount = 5000): Promise<string> {
  const res = await runTool(
    { repo: env.repo, auditor: env.auditor, principal: principal("CUST-1", "customer"), conversationId: null },
    "request_refund",
    { orderId: "ORD-1", amount, reason: "damaged on arrival" },
  );
  expect(res.ok).toBe(true);
  const approvalId = (res.ok ? (res.data as any).approvalId : "") as string;
  await decideApproval(env.repo, env.auditor, admin(), { approvalId, approve: true });
  return approvalId;
}

function setOrderPi(raw: any, pi: string) {
  raw.prepare("UPDATE orders SET stripe_payment_intent_id = ? WHERE id = 'ORD-1'").run(pi);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Stripe refund integration (blueprint §5.4)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.unstubAllEnvs();
    // Keep the provider retry loop (1s/2s/4s default) instant in tests.
    vi.stubEnv("PROVIDER_RETRY_BACKOFF_MS", "1");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    setJobQueueForTesting(undefined);
  });

  it("records the provider refund id on success (DB stays source of truth)", async () => {
    const env = makeEnv();
    setOrderPi(env.raw, "pi_live_abc");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { id: "re_123", status: "succeeded" }));

    const approvalId = await requestAndApprove(env, 5000);
    const { refund } = await executeApprovedAction(env.repo, env.auditor, admin(), approvalId);

    expect(refund.status).toBe("completed");
    expect(refund.providerRefundId).toBe("re_123");
    expect((await env.repo.getOrder("ORD-1"))!.refundableAmount).toBe(7000);

    // Exactly one provider call, form-encoded, with an idempotency key.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/refunds$/);
    const body = init.body as URLSearchParams;
    expect(body.get("payment_intent")).toBe("pi_live_abc");
    expect(body.get("amount")).toBe("5000");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(/^refund:/);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_123");
  });

  it("skips the provider for mock payment intents (seed default) and without a key", async () => {
    const env = makeEnv();
    setOrderPi(env.raw, "pi_mock_ORD-1"); // seed default
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");

    const approvalId = await requestAndApprove(env, 5000);
    const { refund } = await executeApprovedAction(env.repo, env.auditor, admin(), approvalId);

    expect(refund.status).toBe("completed");
    expect(refund.providerRefundId).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("marks pending_execution and queues a background retry when the provider fails", async () => {
    const env = makeEnv();
    setOrderPi(env.raw, "pi_live_abc");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    const enqueued: Array<{ type: string; payload: unknown; dedupe: string | undefined }> = [];
    const fake: JobQueue = {
      kind: "test",
      registerHandler: () => {},
      enqueue: async (type, payload, dedupe) => {
        enqueued.push({ type, payload, dedupe });
        return "JOB-F";
      },
      start: () => {},
      stop: () => {},
      processNow: async () => {},
      size: () => enqueued.length,
    };
    setJobQueueForTesting(fake);
    fetchSpy.mockResolvedValueOnce(jsonResponse(500, { error: "server error" }));

    const approvalId = await requestAndApprove(env, 5000);
    const { refund } = await executeApprovedAction(env.repo, env.auditor, admin(), approvalId);

    expect(refund.status).toBe("pending_execution");
    expect(refund.providerRefundId).toBeNull();
    // The DB refund is still applied (source of truth) — balance decremented once.
    expect((await env.repo.getOrder("ORD-1"))!.refundableAmount).toBe(7000);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].type).toBe("execute_refund_fallback");
    expect((enqueued[0].payload as any).refundId).toBe(refund.id);
  });

  it("self-heals: re-executing a pending_execution refund retries the provider", async () => {
    const env = makeEnv();
    setOrderPi(env.raw, "pi_live_abc");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    setJobQueueForTesting({
      kind: "test", registerHandler: () => {}, enqueue: async () => null,
      start: () => {}, stop: () => {}, processNow: async () => {}, size: () => 0,
    } as JobQueue);

    const approvalId = await requestAndApprove(env, 5000);
    fetchSpy.mockResolvedValueOnce(jsonResponse(500, { error: "down" }));
    const first = (await executeApprovedAction(env.repo, env.auditor, admin(), approvalId)).refund;
    expect(first.status).toBe("pending_execution");

    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { id: "re_777", status: "succeeded" }));
    const second = (await executeApprovedAction(env.repo, env.auditor, admin(), approvalId)).refund;
    expect(second.status).toBe("completed");
    expect(second.providerRefundId).toBe("re_777");
    // Still exactly one refund row; balance decremented only once.
    expect((await env.repo.getRefundsByOrder("ORD-1")).length).toBe(1);
    expect((await env.repo.getOrder("ORD-1"))!.refundableAmount).toBe(7000);
    // 2 attempts on the first execution (500 then exhausted) + 1 on the retry.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("background job settles a pending_execution refund (same idempotency key)", async () => {
    const env = makeEnv();
    setOrderPi(env.raw, "pi_live_abc");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    vi.stubEnv("JOB_RETRY_BACKOFF_MS", "1");
    vi.stubEnv("JOB_MAX_RETRIES", "3");

    // Queue bound to THIS env (the global queue would use the app's global repo).
    const q = createMemoryJobQueue({ ctx: () => ({ repo: env.repo, auditor: env.auditor }) });
    registerStripeJobHandlers(q);
    setJobQueueForTesting(q);

    const approvalId = await requestAndApprove(env, 5000);
    fetchSpy.mockResolvedValueOnce(jsonResponse(500, { error: "down" }));
    const { refund } = await executeApprovedAction(env.repo, env.auditor, admin(), approvalId);
    expect(refund.status).toBe("pending_execution");
    const firstKey = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;

    // A successful provider call on the next attempt settles it.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { id: "re_999", status: "succeeded" }));
    await q.processNow();

    const after = (await env.repo.getRefundsByOrder("ORD-1"))[0];
    expect(after.status).toBe("completed");
    expect(after.providerRefundId).toBe("re_999");
    const secondKey = (fetchSpy.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(secondKey["Idempotency-Key"]).toBe(firstKey["Idempotency-Key"]); // no double refund
    const jobs = env.raw
      .prepare("SELECT action FROM audit_logs WHERE action LIKE 'job.%'")
      .all()
      .map((r: any) => r.action);
    expect(jobs).toContain("job.completed");
  });
});
