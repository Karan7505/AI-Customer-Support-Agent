import type { ApprovalRequest } from "@/lib/types";

/** Add human-readable context (customer name, order summary) to an approval view. */
export async function withContext(repo: any, _auditor: any, ap: ApprovalRequest) {
  const requester = await repo.principalOf(ap.requestedBy);
  const approver = ap.approvedBy ? await repo.principalOf(ap.approvedBy) : null;
  const order = ap.orderId ? await repo.getOrder(ap.orderId) : null;
  return {
    ...ap,
    requestedByName: requester?.name ?? ap.requestedBy,
    requestedByEmail: requester?.email ?? null,
    approvedByName: approver?.name ?? null,
    order: order
      ? {
          id: order.id,
          status: order.status,
          total: order.total,
          currency: order.currency,
          refundableAmount: order.refundableAmount,
        }
      : null,
  };
}
