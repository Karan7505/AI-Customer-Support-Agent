import { logger } from "./logger";
import { dataRetentionAuditYears, dataRetentionCustomerYears } from "./env";
import { nowMs } from "./util";
import { SYSTEM_ACTOR, getJobQueue, type JobQueue } from "./queue";
import type { SoftDeleteTable } from "@/db/repos";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Data retention sweep (blueprint §6.6).
 *
 * Policy:
 *   customers            DATA_RETENTION_CUSTOMER_YEARS (default 1y) — soft-delete
 *   orders/tickets/conversations/messages  2y — soft-delete
 *   audit_logs           DATA_RETENTION_AUDIT_YEARS (default 3y) — hard delete
 *                        (audit rows carry no deleted_at marker; compliance
 *                        retention ends in deletion, count is audited)
 *   refunds              retained forever (financial records) — never swept
 *
 * Runs at most once per week (weekly job, §6.6): an unref'd tick enqueues the
 * sweep with a week-stamped dedupe key. Every sweep writes one
 * `retention.cleanup` audit entry (system actor) with per-table counts and
 * updates data_retention_policy.last_cleanup for observability.
 */

function retentionDaysByTable(): Record<string, number | null> {
  return {
    customers: dataRetentionCustomerYears() * 365,
    orders: 730,
    support_tickets: 730,
    conversations: 730,
    messages: 730,
    audit_logs: dataRetentionAuditYears() * 365,
    refunds: null, // retained forever
  };
}

export function registerRetentionJob(queue: JobQueue): void {
  queue.registerHandler("retention_cleanup", async (job, ctx) => {
    const t0 = nowMs();
    const days = retentionDaysByTable();
    const counts: Record<string, number> = {};
    for (const [table, d] of Object.entries(days)) {
      if (d === null) continue; // refunds: retained forever
      const before = t0 - d * DAY;
      if (table === "audit_logs") {
        counts[table] = await ctx.repo.hardDeleteAuditLogsOlderThan(before);
      } else {
        counts[table] = await ctx.repo.softDeleteExpired(table as SoftDeleteTable, before);
      }
      await ctx.repo.touchDataRetentionPolicy(table, d, t0);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    logger.info("retention cleanup completed", { counts, total, durationMs: nowMs() - t0, jobId: job.id });
    await ctx.auditor.log(
      { actor: SYSTEM_ACTOR },
      "retention.cleanup",
      {
        toolName: "retention_cleanup",
        result: { counts, total },
        status: "success",
        metadata: { retentionDays: days, durationMs: nowMs() - t0 },
      },
    );
  });
}

let lifecycleStarted = false;
let lastRunWeek = -1;

/** Register the retention handler and start the weekly scheduler (idempotent). */
export function ensureLifecycleJobs(): void {
  if (lifecycleStarted) return;
  lifecycleStarted = true;
  const queue = getJobQueue();
  registerRetentionJob(queue);
  const tick = async () => {
    const week = Math.floor(Date.now() / (7 * DAY));
    if (week === lastRunWeek) return;
    lastRunWeek = week;
    try {
      const id = await queue.enqueue("retention_cleanup", { week }, `retention:${week}`);
      if (id) logger.info("retention sweep scheduled", { week, jobId: id });
    } catch (e) {
      logger.warn("retention scheduling failed", { error: e instanceof Error ? e.message : String(e) });
    }
  };
  void tick(); // first sweep at boot, then weekly
  const timer = setInterval(tick, 6 * 60 * 60 * 1000);
  timer.unref?.();
}

/** Test hook. */
export function resetLifecycleJobsForTesting(): void {
  lifecycleStarted = false;
  lastRunWeek = -1;
}
