import type { Order, RefundDecision } from "./types";

/**
 * Deterministic refund eligibility rules. Pure function over an order + the
 * requested amount, so it is trivially unit-testable and independent of the LLM.
 *
 * Amounts are in integer cents.
 */

/** Order statuses that may receive a refund. */
const REFUNDABLE_STATUSES = new Set(["delivered", "partially_refunded"]);

/** Refund window (days) after delivery. */
export const REFUND_WINDOW_DAYS = 30;

/**
 * Idempotency key for a refund action. Binds customer + order + (approval).
 * The SAME approved action re-executed returns the existing refund instead of
 * double-charging.
 */
export function refundIdempotencyKey(params: {
  customerId: string;
  orderId: string;
  approvalId: string;
}): string {
  return `refund:${params.customerId}:${params.orderId}:${params.approvalId}`;
}

/** Request-scoped key (before approval) to prevent duplicate pending requests. */
export function refundRequestKey(params: {
  customerId: string;
  orderId: string;
  amountCents: number;
  reason: string;
}): string {
  // reason normalized (lowercase, trimmed) so minor phrasing diffs still dedupe.
  const reasonNorm = params.reason.toLowerCase().trim();
  return `refundreq:${params.customerId}:${params.orderId}:${params.amountCents}:${reasonNorm}`;
}

export function checkRefundEligibility(
  order: Order,
  requestedCents: number,
  now = Date.now(),
): RefundDecision {
  if (order.status === "cancelled") {
    return { allowed: false, reason: "Order is cancelled; nothing to refund." };
  }
  if (order.status === "refunded") {
    return {
      allowed: false,
      reason: "Order has already been fully refunded.",
    };
  }
  if (!REFUNDABLE_STATUSES.has(order.status)) {
    return {
      allowed: false,
      reason: `Order status '${order.status}' is not eligible for a refund. Refunds require a delivered (or partially refunded) order.`,
      details: { status: order.status, required: [...REFUNDABLE_STATUSES] },
    };
  }
  if (requestedCents <= 0) {
    return { allowed: false, reason: "Refund amount must be greater than zero." };
  }
  if (order.refundableAmount <= 0) {
    return { allowed: false, reason: "No refundable amount remains on this order." };
  }
  if (requestedCents > order.refundableAmount) {
    return {
      allowed: false,
      reason: `Requested amount exceeds the remaining refundable amount.`,
      details: { requestedCents, remainingCents: order.refundableAmount },
    };
  }

  // Refund window for full refunds (partial within delivered is still allowed
  // by amount rules; we only enforce the window for the FULL order amount).
  const isFullRefund = requestedCents >= order.total;
  if (isFullRefund && order.deliveredAt) {
    const ageMs = now - order.deliveredAt;
    if (ageMs > REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      return {
        allowed: false,
        reason: `Full refunds are only available within ${REFUND_WINDOW_DAYS} days of delivery.`,
      };
    }
  }

  return { allowed: true, details: { remainingCents: order.refundableAmount } };
}
