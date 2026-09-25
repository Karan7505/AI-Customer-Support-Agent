import type { Repo } from "@/db/repos";
import { Errors } from "./errors";
import { nowMs } from "./util";
import type { Principal, Refund } from "./types";
import type { Auditor } from "./audit";
import { ROLE_ADMIN } from "@/db/schema";
import { logger } from "./logger";
import { refundRequestsTotal } from "./metrics";
import { stripeSecretKey } from "./env";
import { createStripeRefund, isMockPaymentIntent, registerStripeJobHandlers } from "./stripe";
import { registerStripeConsistencyJob, startStripeConsistencyScheduler } from "./stripe-consistency";
import { getJobQueue } from "./queue";

let stripeHandlersRegistered = false;
function ensureStripeHandlers(): void {
  if (stripeHandlersRegistered) return;
  const queue = getJobQueue();
  registerStripeJobHandlers(queue);
  registerStripeConsistencyJob(queue);
  startStripeConsistencyScheduler(queue);
  stripeHandlersRegistered = true;
}

export interface ExecuteRefundOpts {
  orderId: string;
  amountCents: number;
  reason: string;
  approvalId: string;
  customerId: string;
  /** Canonical idempotency key: refund:<customer>:<order>:<approval>. */
  idempotencyKey: string;
}

export function mapRefund(row: any): Refund {
  return {
    id: row.id,
    orderId: row.orderId,
    customerId: row.customerId,
    amount: row.amount,
    reason: row.reason,
    status: row.status,
    approvalId: row.approvalId,
    idempotencyKey: row.idempotencyKey,
    providerRefundId: row.providerRefundId ?? null,
    createdAt: row.createdAt,
    processedAt: row.processedAt,
  };
}

/**
 * Settle the payment-provider side of a DB-applied refund (blueprint §5.4).
 * DB state is the source of truth; the provider is the replica.
 *  - no key, or a mock payment intent → "skipped" (refund stays completed);
 *  - provider ok → completed + providerRefundId recorded;
 *  - provider fails → pending_execution + job queue retries with the same
 *    idempotency key (never a double refund).
 */
async function settleProviderRefund(
  repo: Repo,
  refund: Refund,
  paymentIntentId: string | null,
  currency: string,
): Promise<{ refund: Refund; providerStatus: "skipped" | "completed" | "pending" }> {
  ensureStripeHandlers();
  const key = stripeSecretKey();
  if (!key || !paymentIntentId || isMockPaymentIntent(paymentIntentId)) {
    return { refund, providerStatus: "skipped" };
  }
  try {
    const r = await createStripeRefund({
      paymentIntentId,
      amountCents: refund.amount,
      currency,
      idempotencyKey: refund.idempotencyKey ?? `refund:${refund.id}`,
    });
    await repo.updateRefund(refund.id, { status: "completed", providerRefundId: r.id });
    logger.info("stripe refund created", { refundId: refund.id, providerRefundId: r.id });
    // The returned object must reflect the DB state (matters when re-settling a
    // refund that came in as pending_execution).
    return { refund: { ...refund, status: "completed", providerRefundId: r.id }, providerStatus: "completed" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await repo.updateRefund(refund.id, { status: "pending_execution" });
    const jobId = await getJobQueue().enqueue(
      "execute_refund_fallback",
      { refundId: refund.id },
      `stripe:${refund.id}`,
    );
    logger.warn("stripe refund failed; queued for background retry", { refundId: refund.id, jobId, error: message });
    return { refund: { ...refund, status: "pending_execution" }, providerStatus: "pending" };
  }
}

/**
 * The protected, transactional refund execution. Called ONLY after a valid
 * approval. It:
 *  1. Re-verifies the order still exists and the amount is still refundable.
 *  2. Is idempotent via the canonical refund idempotency key: if the same
 *     approved action is executed twice, the existing completed refund is
 *     returned and the balance is NOT decremented again.
 *  3. Creates the single refund row at request time; here it is UPDATED to
 *     completed (or created if absent) and the order's refundable balance is
 *     decremented exactly once — all in one transaction.
 *  4. Settles the payment-provider side (Stripe) — DB is source of truth.
 *  5. Emits audit entries and returns the persisted refund.
 */
export async function executeRefund(
  repo: Repo,
  auditor: Auditor,
  executor: Principal,
  opts: ExecuteRefundOpts,
): Promise<Refund> {
  const t0 = nowMs();
  if (executor.role !== ROLE_ADMIN) {
    throw Errors.forbidden("Only an admin can execute a refund.");
  }
  const order = await repo.getOrder(opts.orderId);
  if (!order) throw Errors.notFound("Order");

  const amount = Math.round(opts.amountCents);
  if (amount <= 0) throw Errors.validation("Refund amount must be positive.");

  const existing = await repo.getRefundByIdempotencyKey(opts.idempotencyKey);

  if (existing) {
    // Idempotent no-op: this approved action already produced a refund.
    // Self-heal: a refund stuck at pending_execution retries the provider now.
    if (existing.status === "completed" || existing.status === "pending_execution") {
      if (existing.status === "pending_execution") {
        const settled = await settleProviderRefund(repo, mapRefund(existing), order.stripePaymentIntentId, order.currency);
        refundRequestsTotal.inc({ status: "existing" });
        logger.info("refund re-executed (idempotent), provider re-settled", {
          refundId: existing.id, approvalId: opts.approvalId, providerStatus: settled.providerStatus,
        });
        await auditor.log(
          { actor: executor, approvalId: opts.approvalId },
          "refund.executed_existing",
          {
            toolName: "process_refund", arguments: opts,
            result: { refundId: existing.id, idempotent: true, providerStatus: settled.providerStatus },
            status: "success", durationMs: nowMs() - t0,
            metadata: { idempotent: true, providerStatus: settled.providerStatus },
          },
        );
        return settled.refund;
      }
      refundRequestsTotal.inc({ status: "existing" });
      logger.info("refund already executed (idempotent)", { refundId: existing.id, approvalId: opts.approvalId });
      await auditor.log(
        { actor: executor, approvalId: opts.approvalId },
        "refund.executed_existing",
        {
          toolName: "process_refund", arguments: opts, result: { refundId: existing.id, idempotent: true },
          status: "success", durationMs: nowMs() - t0, metadata: { idempotent: true },
        },
      );
      return mapRefund(existing);
    }
  }

  // Amount must still fit within the remaining refundable balance.
  if (amount > order.refundableAmount) {
    throw Errors.eligibility(
      `Requested ${amount} exceeds remaining refundable ${order.refundableAmount}.`,
    );
  }

  try {
    // Atomic, driver-appropriate write: complete the pending refund row and
    // decrement the order balance exactly once. (SQLite = sync transaction,
    // Postgres = async transaction; both handled by the adapter.)
    const applied = await repo.applyRefund({ orderId: order.id, amount });
    let refund = mapRefund(applied);
    const settled = await settleProviderRefund(repo, refund, order.stripePaymentIntentId, order.currency);
    refund = settled.refund;
    refundRequestsTotal.inc({ status: "completed" });
    logger.info("refund completed", {
      refundId: refund.id, orderId: refund.orderId, amountCents: refund.amount,
      durationMs: nowMs() - t0, providerStatus: settled.providerStatus,
    });
    await auditor.log(
      { actor: executor, approvalId: opts.approvalId },
      "refund.completed",
      {
        toolName: "process_refund",
        arguments: opts,
        result: { refundId: refund.id, amountCents: refund.amount, orderId: refund.orderId, providerStatus: settled.providerStatus, providerRefundId: refund.providerRefundId },
        status: "success", durationMs: nowMs() - t0,
        metadata: { orderId: refund.orderId, amountCents: refund.amount, providerStatus: settled.providerStatus },
      },
    );
    return refund;
  } catch (e) {
    // Persist a failed record (best-effort) so the failure is auditable.
    try {
      if (existing) {
        await repo.updateRefund(existing.id, { status: "failed" });
      }
    } catch {
      /* ignore secondary errors */
    }
    const message = e instanceof Error ? e.message : String(e);
    refundRequestsTotal.inc({ status: "failed" });
    logger.warn("refund execution failed", { approvalId: opts.approvalId, error: message });
    await auditor.log(
      { actor: executor, approvalId: opts.approvalId },
      "refund.failed",
      {
        toolName: "process_refund", arguments: opts, result: { error: message },
        status: "failure", durationMs: nowMs() - t0, metadata: { error: message },
      },
    );
    throw Errors.tool(`Refund processing failed: ${message}`);
  }
}
