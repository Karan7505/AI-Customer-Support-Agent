import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryJobQueue } from "@/lib/queue";
import { setJobQueueForTesting } from "@/lib/queue";
import { notifyEvent, resetNotifyHandlerForTesting } from "@/lib/notify";
import { buildNotificationEmail } from "@/emails/templates";
import { makeEnv } from "../helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("email notifications (blueprint §5.5)", () => {
  let env: ReturnType<typeof makeEnv>;
  let q: ReturnType<typeof createMemoryJobQueue>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    env = makeEnv();
    q = createMemoryJobQueue({ ctx: () => ({ repo: env.repo, auditor: env.auditor }) });
    setJobQueueForTesting(q);
    resetNotifyHandlerForTesting();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("JOB_RETRY_BACKOFF_MS", "1");
    vi.stubEnv("JOB_MAX_RETRIES", "2");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    setJobQueueForTesting(undefined);
  });

  function sentRequests() {
    return fetchSpy.mock.calls.map((c: any[]) => {
      const [url, init] = c as [string, RequestInit];
      return { url, body: JSON.parse(init.body as string) };
    });
  }

  it("is a no-op without a RESEND_API_KEY (zero-config offline)", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("JOB_RETRY_BACKOFF_MS", "1");
    vi.stubEnv("JOB_MAX_RETRIES", "2");
    notifyEvent("ticket_created", { ticketId: "TCK-1", customerId: "CUST-1", subject: "x" });
    await q.processNow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(q.size()).toBe(0);
  });

  it("ticket_created emails the ticket's customer", async () => {
    notifyEvent("ticket_created", { ticketId: "TCK-1", customerId: "CUST-1", subject: "Broken desk mat" });
    await q.processNow();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const { url, body } = sentRequests()[0];
    expect(url).toMatch(/\/emails$/);
    expect(body.to).toEqual(["jane@t.com"]);
    expect(body.subject).toContain("TCK-1");
    expect(body.html).toContain("Broken desk mat");
  });

  it("ticket_updated emails the customer and the support team", async () => {
    vi.stubEnv("SUPPORT_TEAM_EMAIL_LIST", "s1@t.com, s2@t.com");
    notifyEvent("ticket_updated", { ticketId: "TCK-1", customerId: "CUST-1", status: "in_progress", priority: "high" });
    await q.processNow();

    const { body } = sentRequests()[0];
    expect(body.to).toEqual(["jane@t.com", "s1@t.com", "s2@t.com"]);
    expect(body.html).toContain("in_progress");
  });

  it("approval_requested emails the admin list", async () => {
    vi.stubEnv("ADMIN_EMAIL_LIST", "a1@t.com,a2@t.com");
    notifyEvent("approval_requested", {
      approvalId: "APR-1", orderId: "ORD-1", amountCents: 5000, toolName: "process_refund",
    });
    await q.processNow();

    const { body } = sentRequests()[0];
    expect(body.to).toEqual(["a1@t.com", "a2@t.com"]);
    expect(body.subject).toContain("ORD-1");
    expect(body.html).toContain("$50.00");
  });

  it("approval_result (declined) emails the customer with the reason", async () => {
    notifyEvent("approval_result", {
      approvalId: "APR-1", customerId: "CUST-1", orderId: "ORD-1", amountCents: 5000, approved: false, reason: "Not covered by policy",
    });
    await q.processNow();

    const { body } = sentRequests()[0];
    expect(body.to).toEqual(["jane@t.com"]);
    expect(body.subject).toMatch(/declined/i);
    expect(body.html).toContain("Not covered by policy");
  });

  it("skips (without failing) when no recipients are configured", async () => {
    notifyEvent("approval_requested", { approvalId: "APR-9", orderId: "ORD-1", amountCents: 100, toolName: "process_refund" });
    await q.processNow();
    expect(fetchSpy).not.toHaveBeenCalled();
    const audit = env.raw.prepare("SELECT action FROM audit_logs WHERE action = 'job.completed'").all();
    expect(audit.length).toBe(1); // job completed (skipped counts as done)
  });

  it("retries provider failures via the queue and audits job.failed after max attempts", async () => {
    fetchSpy.mockResolvedValue(new Response("bad", { status: 500 }));
    notifyEvent("ticket_created", { ticketId: "TCK-2", customerId: "CUST-1", subject: "x" });
    for (let i = 0; i < 4; i++) {
      await q.processNow();
      await sleep(5);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2); // maxAttempts = 2
    const audit = env.raw
      .prepare("SELECT action, status FROM audit_logs WHERE action LIKE 'job.%'")
      .all()
      .map((r: any) => ({ action: r.action, status: r.status }));
    expect(audit).toContainEqual({ action: "job.failed", status: "failure" });
    expect(audit.some((a) => a.action === "job.retried")).toBe(true);
  });

  it("builds the four templates with stable subjects", () => {
    const a = buildNotificationEmail("ticket_created", { ticketId: "TCK-7", subject: "S" }, { customerName: "Jane" });
    expect(a.subject).toBe("New support ticket TCK-7");
    const b = buildNotificationEmail("approval_result", { orderId: "ORD-1", amountCents: 100, approved: true }, { customerName: "Jane" });
    expect(b.subject).toBe("Refund approved for ORD-1");
  });
});
