/**
 * Notification email templates (blueprint §5.5).
 * One template per event; minimal, readable HTML (no external assets).
 */

export type NotifyEvent = "ticket_created" | "ticket_updated" | "approval_requested" | "approval_result";

export interface NotifyEmail {
  subject: string;
  html: string;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(cents: unknown): string {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "—";
  return `$${(n / 100).toFixed(2)}`;
}

function page(title: string, body: string): string {
  return [
    "<!doctype html><html><body style='margin:0;padding:24px;background:#f6f7f9;font-family:Helvetica,Arial,sans-serif;color:#1a202c;'>",
    `<div style='max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;'>`,
    `<h2 style='margin:0 0 16px;font-size:18px;'>${esc(title)}</h2>`,
    body,
    `<p style='margin:24px 0 0;font-size:12px;color:#718096;'>Aurora Support — automated notification. If you did not expect this email, you can safely ignore it.</p>`,
    "</div></body></html>",
  ].join("");
}

export function buildNotificationEmail(
  event: NotifyEvent,
  payload: Record<string, unknown>,
  names: { customerName?: string } = {},
): NotifyEmail {
  const customerName = names.customerName ?? "there";
  switch (event) {
    case "ticket_created":
      return {
        subject: `New support ticket ${String(payload.ticketId ?? "")}`,
        html: page(`Ticket ${esc(payload.ticketId)} created`,
          `<p>Hi ${esc(customerName)},</p>
           <p>Your support ticket has been created.</p>
           <ul style='line-height:1.6'>
             <li><strong>Ticket:</strong> ${esc(payload.ticketId)}</li>
             <li><strong>Subject:</strong> ${esc(payload.subject)}</li>
           </ul>
           <p>We will reply here as soon as someone looks at it.</p>`),
      };
    case "ticket_updated":
      return {
        subject: `Update on ticket ${String(payload.ticketId ?? "")}`,
        html: page(`Ticket ${esc(payload.ticketId)} update`,
          `<p>Hi ${esc(customerName)},</p>
           <p>Your support ticket was updated.</p>
           <ul style='line-height:1.6'>
             <li><strong>Ticket:</strong> ${esc(payload.ticketId)}</li>
             <li><strong>Status:</strong> ${esc(payload.status)}</li>
             <li><strong>Priority:</strong> ${esc(payload.priority)}</li>
           </ul>`),
      };
    case "approval_requested":
      return {
        subject: `Approval required: refund for ${String(payload.orderId ?? "an order")}`,
        html: page("Refund awaiting approval",
          `<p>A high-risk refund action is waiting for an admin decision.</p>
           <ul style='line-height:1.6'>
             <li><strong>Approval:</strong> ${esc(payload.approvalId)}</li>
             <li><strong>Order:</strong> ${esc(payload.orderId ?? "—")}</li>
             <li><strong>Amount:</strong> ${esc(money(payload.amountCents))}</li>
             <li><strong>Action:</strong> ${esc(payload.toolName)}</li>
           </ul>
           <p>Open the admin dashboard to approve or reject it.</p>`),
      };
    case "approval_result": {
      const approved = payload.approved === true;
      return {
        subject: `${approved ? "Refund approved" : "Refund declined"} for ${String(payload.orderId ?? "your order")}`,
        html: page(`${approved ? "Refund approved" : "Refund declined"} — ${esc(payload.orderId ?? "")}`,
          `<p>Hi ${esc(customerName)},</p>
           <p>Your refund request for <strong>${esc(payload.orderId ?? "your order")}</strong> was
           <strong>${approved ? "approved" : "declined"}</strong>.</p>
           <ul style='line-height:1.6'>
             <li><strong>Amount:</strong> ${esc(money(payload.amountCents))}</li>
             ${approved ? "" : `<li><strong>Reason:</strong> ${esc(payload.reason ?? "not specified")}</li>`}
           </ul>
           ${approved ? "<p>The refund is being processed. It usually appears on your original payment method within a few business days.</p>" : ""}`),
      };
    }
  }
}
