import { logger } from "./logger";
import { stripeSecretKey } from "./env";
import { getStripeRefund } from "./stripe";
import { SYSTEM_ACTOR, type JobQueue } from "./queue";

/**
 * Stripe consistency check (blueprint §8.5).
 *
 * The database is the source of truth and Stripe is the money replica. This
 * job reconciles the two at most once per calendar month:
 *
 *  - completed refund MISSING in Stripe  -> marked `orphaned` + error log +
 *    audit `refund.orphaned` (ops alert; recover by investigating the payment
 *    intent in Stripe, NOT by re-refunding from this app);
 *  - completed refund reported `failed`  -> audit `refund.consistency_mismatch`
 *    + warn log; the DB state is deliberately left untouched for manual review
 *    (a partial/failed provider refund needs ops judgment, not automation).
 *
 * Scheduling: an unref'd hourly tick enqueues the job once per month (the
 * month is tracked in-process; the dedupe key guards the window while the job
 * is in flight). With no STRIPE_SECRET_KEY the job is a no-op (DB-only mode).
 */

export function registerStripeConsistencyJob(queue: JobQueue): void {
  queue.registerHandler("check_stripe_consistency", async (job, ctx) => {
    if (!stripeSecretKey()) {
      logger.info("stripe consistency check skipped (no STRIPE_SECRET_KEY)");
      return;
    }
    const refunds = await ctx.repo.getSettledRefundsForConsistency();
    let orphans = 0;
    let mismatches = 0;
    for (const r of refunds) {
      const found = await getStripeRefund(r.providerRefundId!);
      if (!found) {
        orphans += 1;
        await ctx.repo.updateRefund(r.id, { status: "orphaned" });
        logger.error("stripe refund orphaned (completed in DB, missing in Stripe)", {
          refundId: r.id,
          providerRefundId: r.providerRefundId,
        });
        await ctx.auditor.log(
          { actor: SYSTEM_ACTOR, approvalId: r.approvalId },
          "refund.orphaned",
          {
            toolName: "check_stripe_consistency",
            result: { refundId: r.id, providerRefundId: r.providerRefundId },
            status: "failure",
            metadata: { provider: "stripe" },
          },
        );
      } else if (found.status === "failed") {
        mismatches += 1;
        logger.warn("stripe refund status mismatch (Stripe reports failed; investigate with ops)", {
          refundId: r.id,
          providerRefundId: r.providerRefundId,
          stripeStatus: found.status,
        });
        await ctx.auditor.log(
          { actor: SYSTEM_ACTOR, approvalId: r.approvalId },
          "refund.consistency_mismatch",
          {
            toolName: "check_stripe_consistency",
            result: { refundId: r.id, providerRefundId: r.providerRefundId, stripeStatus: found.status },
            status: "failure",
            metadata: { provider: "stripe" },
          },
        );
      }
    }
    logger.info("stripe consistency check completed", {
      checked: refunds.length,
      orphans,
      mismatches,
      jobId: job.id,
    });
    await ctx.auditor.log(
      { actor: SYSTEM_ACTOR },
      "stripe.consistency_check",
      {
        toolName: "check_stripe_consistency",
        result: { checked: refunds.length, orphans, mismatches },
        status: "success",
        metadata: { provider: "stripe" },
      },
    );
  });
}

let schedulerStarted = false;
let lastCheckedMonth = -1;

/** Enqueue the monthly consistency job (at most once per calendar month). */
export function startStripeConsistencyScheduler(queue: JobQueue): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const tick = async () => {
    const now = new Date();
    const month = now.getUTCFullYear() * 12 + now.getUTCMonth();
    if (month === lastCheckedMonth) return;
    lastCheckedMonth = month;
    try {
      const id = await queue.enqueue("check_stripe_consistency", { month }, `stripe-consistency:${month}`);
      if (id) logger.info("stripe consistency check scheduled", { month, jobId: id });
    } catch (e) {
      logger.warn("stripe consistency scheduling failed", { error: e instanceof Error ? e.message : String(e) });
    }
  };
  void tick(); // first run at boot, then once per calendar month
  const timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref?.();
}

/** Test hook. */
export function resetStripeConsistencySchedulerForTesting(): void {
  schedulerStarted = false;
  lastCheckedMonth = -1;
}
