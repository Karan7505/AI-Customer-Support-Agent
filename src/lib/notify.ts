import { logger } from "./logger";
import {
  adminEmailList,
  notificationsEnabled,
  notificationsFrom,
  resendApiKey,
  resendApiBase,
  supportTeamEmailList,
} from "./env";
import { getJobQueue, type Job, type JobContext, type JobHandler } from "./queue";
import { buildNotificationEmail, type NotifyEvent } from "@/emails/templates";

/**
 * Event-driven email notifications (blueprint §5.5) via Resend.
 *
 * Semantics:
 *  - Fire-and-forget: `notifyEvent` never throws and never blocks a request;
 *    delivery happens through the job queue with retries.
 *  - Off without a RESEND_API_KEY (debug log only), or when
 *    NOTIFICATIONS_ENABLED=false.
 *  - Recipients:
 *      ticket_created      -> customer
 *      ticket_updated      -> customer + SUPPORT_TEAM_EMAIL_LIST
 *      approval_requested  -> ADMIN_EMAIL_LIST
 *      approval_result     -> customer
 *
 * The `system` principal performs all audit writes for the jobs themselves
 * (handled by the queue); existing audit entries are unchanged.
 */

interface EmailJobPayload {
  event: NotifyEvent;
  payload: Record<string, unknown>;
}

function dedupeKeyFor(event: NotifyEvent, payload: Record<string, unknown>): string {
  if (event === "account_verification" || event === "password_reset") {
    return `email:${event}:${String(payload.token ?? "")}`;
  }
  const id = String(
    (event.startsWith("ticket") ? payload.ticketId : payload.approvalId) ?? "",
  );
  if (event === "ticket_updated") {
    return `email:ticket_updated:${id}:${String(payload.status ?? "")}:${String(payload.priority ?? "")}`;
  }
  if (event === "approval_result") {
    return `email:approval_result:${id}:${payload.approved ? 1 : 0}`;
  }
  return `email:${event}:${id}`;
}

let handlerRegistered = false;

/**
 * Idempotency for email delivery (blueprint §8.2): the deterministic email id
 * (the dedupe key) is remembered after a successful send, so a re-enqueued
 * job for the SAME email can never send it twice — the queue's dedupe only
 * covers jobs that are still queued/running. In-process by design (MVP);
 * bounded to the most recent sends.
 */
const sentEmails = new Set<string>();
const SENT_EMAILS_CAP = 10_000;

const handleEmailJob: JobHandler = async (job, ctx) => {
  const { event, payload } = job.payload as unknown as EmailJobPayload;
  if (!event || !payload) throw new Error("malformed email job payload");

  const emailId = dedupeKeyFor(event, payload);
  if (sentEmails.has(emailId)) {
    logger.info("email job skipped (already sent; idempotent)", { emailId, event });
    return;
  }

  const recipients: string[] = [];
  let customerName: string | undefined;
  const customerId = typeof payload.customerId === "string" ? payload.customerId : undefined;

  if (event === "approval_requested") {
    recipients.push(...adminEmailList());
  } else if (event === "account_verification" || event === "password_reset") {
    // Self-addressed: the (possibly not-yet-verified) account's own email.
    if (typeof payload.email === "string") recipients.push(payload.email);
    customerName = typeof payload.name === "string" ? payload.name : undefined;
  } else {
    if (customerId) {
      const c = await ctx.repo.getCustomer(customerId);
      if (c?.email) recipients.push(c.email);
      customerName = c?.name;
    }
    if (event === "ticket_updated") recipients.push(...supportTeamEmailList());
  }

  if (recipients.length === 0) {
    logger.info("notify job skipped (no recipients configured)", { event, jobType: "send_email_notification" });
    return;
  }

  const { subject, html } = buildNotificationEmail(event, payload, { customerName });
  const res = await fetch(`${resendApiBase()}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: notificationsFrom(), to: recipients, subject, html }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`resend failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  sentEmails.add(emailId);
  if (sentEmails.size > SENT_EMAILS_CAP) {
    for (const k of [...sentEmails].slice(0, SENT_EMAILS_CAP / 2)) sentEmails.delete(k);
  }
  logger.info("notification email sent", { event, recipients: recipients.length, subject });
};

function ensureHandler(): void {
  if (handlerRegistered) return;
  getJobQueue().registerHandler("send_email_notification", handleEmailJob);
  handlerRegistered = true;
}

/**
 * Queue a notification for an event. Returns immediately; failures are
 * isolated to the job queue (retries + job.failed audit).
 */
export function notifyEvent(event: NotifyEvent, payload: Record<string, unknown>): void {
  try {
    if (!notificationsEnabled()) {
      logger.debug("notifications disabled; skipping", { event });
      return;
    }
    if (!resendApiKey()) {
      logger.debug("notify skipped (no RESEND_API_KEY)", { event });
      return;
    }
    ensureHandler();
    const dedupeKey = dedupeKeyFor(event, payload);
    void getJobQueue()
      .enqueue("send_email_notification", { event, payload }, dedupeKey)
      .catch((e) => logger.warn("notify enqueue failed", { event, error: e instanceof Error ? e.message : String(e) }));
  } catch (e) {
    logger.warn("notify event failed (isolated)", { event, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Test hook: allow tests to reset the registration flag when swapping queues. */
export function resetNotifyHandlerForTesting(): void {
  handlerRegistered = false;
}

/** Test hook: drop the sent-email idempotency set. */
export function resetSentEmailsForTesting(): void {
  sentEmails.clear();
}
