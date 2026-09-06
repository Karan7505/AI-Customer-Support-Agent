import type { Repo } from "@/db/repos";
import { Errors } from "./errors";
import { nowMs } from "./util";
import type { Principal, Refund } from "./types";
import type { Auditor } from "./audit";
import { ROLE_ADMIN } from "@/db/schema";

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
export function executeRefund(
  repo: Repo,
  auditor: Auditor,
  executor: Principal,
  opts: ExecuteRefundOpts,
): Refund {
  if (executor.role !== ROLE_ADMIN) {
    throw Errors.forbidden("Only an admin can execute a refund.");
  }
  const order = repo.getOrder(opts.orderId);
  if (!order) throw Errors.notFound("Order");

  const amount = Math.round(opts.amountCents);
  if (amount <= 0) throw Errors.validation("Refund amount must be positive.");

  const existing = repo.getRefundByIdempotencyKey(opts.idempotencyKey);

  // Idempotent no-op: this approved action already produced a completed refund.
  if (existing && existing.status === "completed") {
    auditor.log(
      { actor: executor, approvalId: opts.approvalId },
      "refund.executed_existing",
      { toolName: "process_refund", arguments: opts, result: { refundId: existing.id, idempotent: true } },
    );
    return mapRefund(existing);
  }

  // Amount must still fit within the remaining refundable balance.
  if (amount > order.refundableAmount) {
    throw Errors.eligibility(
      `Requested ${amount} exceeds remaining refundable ${order.refundableAmount}.`,
    );
  }

  const t = nowMs();
  let refundId = existing ? existing.id : undefined;

  try {
    repo.transaction(() => {
      if (existing) {
        // Update the pending refund created at request time -> completed.
        repo.updateRefund(existing.id, { status: "completed", processedAt: t });
        refundId = existing.id;
      } else {
        // No pending record (e.g. created directly via approval). Insert one.
        const newId = `REF-${opts.approvalId.slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
        refundId = newId;
        repo.createRefund({
          id: newId,
          orderId: order.id,
          customerId: order.customerId,
          amount,
          reason: opts.reason,
          status: "completed",
          approvalId: opts.approvalId,
          idempotencyKey: opts.idempotencyKey,
          createdAt: t,
          processedAt: t,
        });
      }
      const remaining = order.refundableAmount - amount;
      const newStatus = remaining <= 0 ? "refunded" : "partially_refunded";
      repo.updateOrderRefundState(order.id, Math.max(0, remaining), newStatus);
    });
  } catch (e) {
    // Persist a failed record (best-effort) so the failure is auditable.
    try {
      if (!existing) {
        repo.createRefund({
          id: refundId ?? `REF-fail-${opts.approvalId}`,
          orderId: order.id,
          customerId: order.customerId,
          amount,
          reason: opts.reason,
          status: "failed",
          approvalId: opts.approvalId,
          idempotencyKey: opts.idempotencyKey,
          createdAt: t,
          processedAt: null,
        });
      } else {
        repo.updateRefund(existing.id, { status: "failed" });
      }
    } catch {
      /* ignore secondary errors */
    }
    auditor.log(
      { actor: executor, approvalId: opts.approvalId },
      "refund.failed",
      { toolName: "process_refund", arguments: opts, result: { error: e instanceof Error ? e.message : String(e) } },
    );
    throw Errors.tool(
      `Refund processing failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const refund = mapRefund(repo.getRefund(refundId!)!);
  auditor.log(
    { actor: executor, approvalId: opts.approvalId },
    "refund.completed",
    {
      toolName: "process_refund",
      arguments: opts,
      result: { refundId: refund.id, amountCents: refund.amount, orderId: refund.orderId },
    },
  );
  return refund;
}
