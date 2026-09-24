import { logger } from "./logger";
import { stripeApiBase, stripeSecretKey } from "./env";
import type { JobQueue } from "./queue";
import type { Repo } from "@/db/repos";
import type { Auditor } from "./audit";

/**
 * Minimal Stripe refund client (blueprint §5.4) — raw REST, no SDK dependency.
 *
 * The database is the source of truth for order balances; Stripe is the money
 * replica. A refund is applied to the DB first (transactional, idempotent),
 * then pushed to Stripe with the refund's idempotency key so retries can never
 * double-refund. If Stripe is unreachable the refund is marked
 * `pending_execution` and the job queue retries it.
 *
 * Mock payment intents (prefix `pi_mock_`, used by the seed) always no-op:
 * they only exist so the flow is demonstrable without a live key.
 */

export interface StripeRefundResult {
  id: string;
  status: string;
}

export function isMockPaymentIntent(pi: string | null | undefined): boolean {
  return !!pi && pi.startsWith("pi_mock_");
}

export async function createStripeRefund(opts: {
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
}): Promise<StripeRefundResult> {
  const key = stripeSecretKey();
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  const body = new URLSearchParams({
    payment_intent: opts.paymentIntentId,
    amount: String(opts.amountCents),
    currency: opts.currency.toLowerCase(),
  });
  const res = await fetch(`${stripeApiBase()}/refunds`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": opts.idempotencyKey,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`stripe refund failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { id?: string; status?: string };
  if (!data.id) throw new Error("stripe refund response missing id");
  return { id: data.id, status: data.status ?? "succeeded" };
}

import type { Principal } from "./types";

const SYSTEM_ACTOR: Principal = {
  id: "system",
  role: "system",
  name: "System",
  email: "system@local",
};

/**
 * Register the background retry handler for refunds whose provider call failed.
 * Retries use the SAME idempotency key, so a retry after an unknown-outcome
 * network error cannot produce a second provider refund.
 */
export function registerStripeJobHandlers(queue: JobQueue): void {
  queue.registerHandler("execute_refund_fallback", async (job, c: { repo: Repo; auditor: Auditor }) => {
    const { refundId } = job.payload as { refundId: string };
    const refund = await c.repo.getRefund(refundId);
    if (!refund) throw new Error(`refund ${refundId} not found`);
    if (refund.status === "completed" && refund.providerRefundId) return; // already settled
    const order = await c.repo.getOrder(refund.orderId);
    const pi = order?.stripePaymentIntentId;
    if (!pi || isMockPaymentIntent(pi)) throw new Error("order has no real payment intent to refund");
    const r = await createStripeRefund({
      paymentIntentId: pi,
      amountCents: refund.amount,
      currency: order!.currency,
      idempotencyKey: refund.idempotencyKey ?? `refund:${refund.id}`,
    });
    await c.repo.updateRefund(refund.id, { status: "completed", providerRefundId: r.id });
    logger.info("stripe refund settled by job", { refundId, providerRefundId: r.id });
    await c.auditor.log(
      { actor: SYSTEM_ACTOR, approvalId: refund.approvalId },
      "refund.provider_completed",
      {
        toolName: "process_refund",
        result: { refundId: refund.id, providerRefundId: r.id },
        status: "success",
        metadata: { provider: "stripe" },
      },
    );
  });
}
