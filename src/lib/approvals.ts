import type { Repo } from "@/db/repos";
import { genId } from "./ids";
import { Errors } from "./errors";
import { approvalTtlMs } from "./env";
import { nowMs } from "./util";
import type { ApprovalRequest, Principal, Refund } from "./types";
import type { Auditor } from "./audit";
import { executeRefund, mapRefund } from "./refund-execution";
import { refundIdempotencyKey } from "./refunds";
import { ROLE_ADMIN } from "@/db/schema";

/**
 * Approval state machine. An approval can only leave pending_approval, and
 * only to a terminal state. A single approval can only ever be executed once
 * (enforced by the refund idempotency key bound to the approval).
 */
export const APPROVAL_TRANSITIONS: Record<string, string[]> = {
  pending_approval: ["approved", "rejected", "expired"],
  approved: [],
  rejected: [],
  expired: [],
};

export function canTransition(from: string, to: string): boolean {
  return (APPROVAL_TRANSITIONS[from] ?? []).includes(to);
}

export function mapApproval(row: any): ApprovalRequest {
  return {
    id: row.id,
    requestedBy: row.requestedBy,
    actorRole: row.actorRole,
    actionType: row.actionType,
    toolName: row.toolName,
    arguments: JSON.parse(row.arguments || "{}"),
    riskLevel: row.riskLevel,
    status: row.status,
    approvedBy: row.approvedBy,
    rejectionReason: row.rejectionReason,
    orderId: row.orderId,
    amountCents: row.amountCents,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

export interface CreateApprovalOpts {
  requestedBy: Principal;
  actionType: string;
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: string;
  orderId?: string | null;
  amountCents?: number | null;
  idempotencyKey?: string | null;
  conversationId?: string | null;
}

/**
 * Create (or return the existing) approval request for a pending action.
 * Idempotent on a per-customer/per-order/per-action basis so re-asking does
 * not pile up duplicate pending approvals.
 */
export async function createApproval(
  repo: Repo,
  auditor: Auditor,
  opts: CreateApprovalOpts,
): Promise<ApprovalRequest> {
  const t = nowMs();
  // Dedupe: reuse an existing pending approval for the same action+args.
  if (opts.idempotencyKey) {
    const existing = await repo.getPendingApprovalByIdempotencyKey(opts.idempotencyKey);
    if (existing) {
      const ap = mapApproval(existing);
      await auditor.log(
        { actor: opts.requestedBy, conversationId: opts.conversationId, approvalId: ap.id },
        "approval.request_existing",
        { toolName: opts.toolName, arguments: opts.arguments, result: { reused: ap.id } },
      );
      return ap;
    }
  }

  const id = genId("APR");
  await repo.createApproval({
    id,
    requestedBy: opts.requestedBy.id,
    actorRole: opts.requestedBy.role,
    actionType: opts.actionType,
    toolName: opts.toolName,
    arguments: JSON.stringify(opts.arguments),
    riskLevel: opts.riskLevel,
    status: "pending_approval",
    orderId: opts.orderId ?? null,
    amountCents: opts.amountCents ?? null,
    idempotencyKey: opts.idempotencyKey ?? null,
    createdAt: t,
  });
  const row = (await repo.getApproval(id))!;
  const ap = mapApproval(row);
  await auditor.log(
    { actor: opts.requestedBy, conversationId: opts.conversationId, approvalId: ap.id },
    "approval.created",
    { toolName: opts.toolName, arguments: opts.arguments, result: { approvalId: ap.id, risk: ap.riskLevel } },
  );
  return ap;
}

/** Mark an approval expired if it has outlived its TTL (called on read/decide). */
async function maybeExpire(repo: Repo, row: any): Promise<any> {
  if (row.status !== "pending_approval") return row;
  if (nowMs() - row.createdAt > approvalTtlMs()) {
    await repo.updateApproval(row.id, { status: "expired", resolvedAt: nowMs() });
    return { ...row, status: "expired" };
  }
  return row;
}

export interface DecideOpts {
  approvalId: string;
  approve: boolean;
  reason?: string;
}

/** Admin decision. Only admins may approve/reject. Returns the new approval. */
export async function decideApproval(
  repo: Repo,
  auditor: Auditor,
  approver: Principal,
  opts: DecideOpts,
): Promise<ApprovalRequest> {
  if (approver.role !== ROLE_ADMIN) {
    throw Errors.forbidden("Only an admin can approve or reject a request.");
  }
  const row = await repo.getApproval(opts.approvalId);
  if (!row) throw Errors.approvalNotFound(opts.approvalId);
  await maybeExpire(repo, row);
  const current = (await repo.getApproval(opts.approvalId))!;
  if (current.status === "expired") throw Errors.approvalExpired(current.id);
  if (current.status !== "pending_approval") {
    throw Errors.approvalNotApproved(current.id);
  }
  const to = opts.approve ? "approved" : "rejected";
  if (!canTransition(current.status, to)) {
    throw Errors.approvalNotApproved(current.id);
  }
  await repo.updateApproval(current.id, {
    status: to,
    approvedBy: approver.id,
    rejectionReason: opts.approve ? null : opts.reason ?? null,
    resolvedAt: nowMs(),
  });
  // Keep the linked refund record in sync (e.g. rejected refunds).
  const linkedRefund = await repo.getRefundByApprovalId(current.id);
  if (linkedRefund && !opts.approve) {
    await repo.updateRefund(linkedRefund.id, { status: "rejected" });
  }
  const updated = mapApproval((await repo.getApproval(current.id))!);
  await auditor.log(
    { actor: approver, approvalId: current.id },
    opts.approve ? "approval.approved" : "approval.rejected",
    {
      toolName: current.toolName,
      arguments: updated.arguments,
      result: { approved: opts.approve, reason: opts.reason ?? null },
    },
  );
  return updated;
}

/**
 * Execute an APPROVED action exactly once. Reads the exact bound arguments
 * from the approval (never from a caller), runs the refund transaction, and is
 * idempotent via the refund idempotency key.
 */
export async function executeApprovedAction(
  repo: Repo,
  auditor: Auditor,
  executor: Principal,
  approvalId: string,
): Promise<{ refund: Refund; approval: ApprovalRequest }> {
  if (executor.role !== ROLE_ADMIN) {
    throw Errors.forbidden("Only an admin can execute an approved action.");
  }
  const row = await repo.getApproval(approvalId);
  if (!row) throw Errors.approvalNotFound(approvalId);
  if (row.status !== "approved") {
    throw Errors.approvalNotApproved(approvalId);
  }
  const approval = mapApproval(row);

  if (approval.toolName === "process_refund") {
    const args = approval.arguments as any;
    const orderId = (args.orderId as string) ?? approval.orderId!;
    const order = await repo.getOrder(orderId);
    if (!order) throw Errors.notFound("Order");
    // The pending refund was created (in request_refund) keyed to the ORDER'S
    // owner, not the requesting actor. Use the same key so execution finds and
    // completes that exact row (crucial for staff-initiated refunds, where the
    // actor differs from the target customer).
    const refundKey = refundIdempotencyKey({
      customerId: order.customerId,
      orderId,
      approvalId,
    });
    const refund = await executeRefund(repo, auditor, executor, {
      orderId,
      amountCents: args.amount as number,
      reason: args.reason as string,
      approvalId,
      customerId: order.customerId,
      idempotencyKey: refundKey,
    });
    return { refund, approval };
  }

  throw Errors.tool(`Unknown approval action type: ${approval.toolName}`);
}
