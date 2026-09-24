import { describe, it, expect, afterEach, vi } from "vitest";
import { createDb } from "@/db/client";
import { createSqliteRepo } from "@/db/repos";
import { createAuditor } from "@/lib/audit";
import { createMemoryJobQueue } from "@/lib/queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jobAudit(raw: any): { action: string; status: string; actorId: string }[] {
  return raw
    .prepare("SELECT action, status, actor_id FROM audit_logs WHERE action LIKE 'job.%' ORDER BY timestamp ASC")
    .all()
    .map((r: any) => ({ action: r.action, status: r.status, actorId: r.actor_id }));
}

describe("in-memory job queue (blueprint §5.6)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("executes a job and audits job.completed under the system principal", async () => {
    vi.stubEnv("JOB_RETRY_BACKOFF_MS", "1");
    vi.stubEnv("JOB_MAX_RETRIES", "3");
    const { db, raw } = createDb(":memory:");
    const repo = createSqliteRepo(db);
    const auditor = createAuditor(repo);
    const seen: unknown[] = [];
    const q = createMemoryJobQueue({ ctx: () => ({ repo, auditor }) });
    q.registerHandler("send_email_notification", async (job) => {
      seen.push(job.payload);
    });

    const id = await q.enqueue("send_email_notification", { event: "ticket_created" }, "k1");
    expect(id).toMatch(/^JOB-/);
    expect(q.size()).toBe(1);

    await q.processNow();
    expect(seen).toEqual([{ event: "ticket_created" }]);
    expect(q.size()).toBe(0);

    expect(jobAudit(raw)).toContainEqual(
      expect.objectContaining({ action: "job.completed", status: "success", actorId: "system" }),
    );
  });

  it("retries with backoff and audits job.retried then job.failed after max attempts", async () => {
    vi.stubEnv("JOB_RETRY_BACKOFF_MS", "1");
    vi.stubEnv("JOB_MAX_RETRIES", "2");
    const { db, raw } = createDb(":memory:");
    const repo = createSqliteRepo(db);
    const auditor = createAuditor(repo);
    let calls = 0;
    const q = createMemoryJobQueue({ ctx: () => ({ repo, auditor }) });
    q.registerHandler("execute_refund_fallback", async () => {
      calls += 1;
      throw new Error("provider down");
    });

    await q.enqueue("execute_refund_fallback", { refundId: "REF-1" }, "s1");
    for (let i = 0; i < 5; i++) {
      await q.processNow();
      await sleep(5);
    }
    expect(calls).toBe(2); // maxAttempts = 2
    const audit = jobAudit(raw);
    expect(audit.some((a) => a.action === "job.retried")).toBe(true);
    expect(audit).toContainEqual(expect.objectContaining({ action: "job.failed", status: "failure" }));
    expect(q.size()).toBe(0);
  });

  it("dedupes enqueues with the same dedupe key while a job is in flight", async () => {
    vi.stubEnv("JOB_RETRY_BACKOFF_MS", "1");
    vi.stubEnv("JOB_MAX_RETRIES", "3");
    const { db, raw } = createDb(":memory:");
    const repo = createSqliteRepo(db);
    const auditor = createAuditor(repo);
    let run = 0;
    const q = createMemoryJobQueue({ ctx: () => ({ repo, auditor }) });
    q.registerHandler("send_email_notification", async () => {
      run += 1;
    });

    const a = await q.enqueue("send_email_notification", { n: 1 }, "dup");
    const b = await q.enqueue("send_email_notification", { n: 2 }, "dup");
    expect(a).toBeTruthy();
    expect(b).toBeNull(); // duplicate while queued
    await q.processNow();
    expect(run).toBe(1);
  });

  it("fails a job with no registered handler", async () => {
    vi.stubEnv("JOB_RETRY_BACKOFF_MS", "1");
    vi.stubEnv("JOB_MAX_RETRIES", "3");
    const { db, raw } = createDb(":memory:");
    const repo = createSqliteRepo(db);
    const auditor = createAuditor(repo);
    const q = createMemoryJobQueue({ ctx: () => ({ repo, auditor }) });
    await q.enqueue("escalate_ticket", { ticketId: "TCK-1" });
    await q.processNow();
    expect(jobAudit(raw)).toContainEqual(
      expect.objectContaining({ action: "job.failed", status: "failure" }),
    );
  });
});
