import type { Repo } from "@/db/repos";
import { Errors } from "./errors";
import { nowMs } from "./util";
import type { Principal, Refund } from "./types";
import type { Auditor } from "./audit";
import { ROLE_ADMIN } from "@/db/schema";
import { logger } from "./logger";
import { refundRequestsTotal } from "./metrics";

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
    createdAt: row.createdAt,
    processedAt: row.processedAt,
  };
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
 *  4. Emits audit entries and returns the persisted refund.
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

  // Idempotent no-op: this approved action already produced a completed refund.
  if (existing && existing.status === "completed") {
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
    const refund = mapRefund(applied);
    refundRequestsTotal.inc({ status: "completed" });
    logger.info("refund completed", {
      refundId: refund.id, orderId: refund.orderId, amountCents: refund.amount, durationMs: nowMs() - t0,
    });
    await auditor.log(
      { actor: executor, approvalId: opts.approvalId },
      "refund.completed",
      {
        toolName: "process_refund",
        arguments: opts,
        result: { refundId: refund.id, amountCents: refund.amount, orderId: refund.orderId },
        status: "success", durationMs: nowMs() - t0, metadata: { orderId: refund.orderId, amountCents: refund.amount },
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
