import type { LlmClient, LlmMessage, LlmPlan, LlmTool } from "./llm";
import { lookupPolicy } from "./knowledge";
import { formatCents } from "./util";
import type { Order, TrackingStatus, SupportTicket } from "./types";

/**
 * Deterministic, offline "planner". It behaves like a tool-calling LLM: given
 * the conversation it proposes the NEXT tool call or a final message.
 *
 * It does NOT enforce any rules. It only proposes. The agent loop is what
 * authorizes, validates, classifies risk, requires approval, and executes.
 * This makes the full workflow reproducible with no API key.
 */

const ORDER_RE = /ORD-\d+/gi;
const MONEY_RE = /(?:\$|usd\s?)\s?(\d+(?:\.\d{1,2})?)/i;
const DOLLARS_RE = /(\d+(?:\.\d{1,2})?)\s?dollars?/i;

function lastUserText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content ?? "";
  }
  return "";
}
function lastToolMsg(messages: LlmMessage[]): LlmMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool") return messages[i];
  }
  return undefined;
}
function lastAssistantText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i].content ?? "";
  }
  return "";
}

function extractOrderId(text: string): string | undefined {
  const m = text.match(ORDER_RE);
  return m ? m[0].toUpperCase() : undefined;
}

/** Most recently mentioned order id across the conversation (for "for this"). */
function extractOrderIdFromContext(messages: LlmMessage[]): string | undefined {
  const texts: string[] = [];
  for (const m of messages.slice(-6)) {
    if (m.role === "assistant" || m.role === "user") texts.push(m.content ?? "");
  }
  const ids = texts.join(" ").match(ORDER_RE);
  return ids && ids.length ? ids[ids.length - 1].toUpperCase() : undefined;
}

function extractAmountCents(text: string): number | undefined {
  const m = text.match(MONEY_RE) ?? text.match(DOLLARS_RE);
  if (!m) return undefined;
  return Math.round(parseFloat(m[1]) * 100);
}

function hasRefundAction(t: string): boolean {
  return /refund/i.test(t) && /\b(my|orders?|last)\b|\$\s?\d|ORD-\d|money back/i.test(t);
}
/**
 * A return/cancellation request vs. a policy question. Action phrasing is
 * "return/cancel" + a self-referential pronoun ("my/our/this/that/it") or an
 * explicit order id ("return order ORD-1"). "What is the return policy?" has
 * neither, so it still routes to lookup_policy.
 */
function hasReturnAction(t: string): boolean {
  return /\breturn(ing)?\b/i.test(t) && (/\b(my|our|this|that|it)\b/i.test(t) || !!extractOrderId(t));
}
/** "I want to cancel my order" — a cancellation request about own items. */
function hasCancelAction(t: string): boolean {
  return /\bcancel(led|ling)?\b/i.test(t) && (/\b(my|our|this|that|it)\b/i.test(t) || !!extractOrderId(t));
}
function hasOrderAction(t: string): boolean {
  const base =
    /where is my order|where.*order|track|tracking|shipped|delivered|my order|check order|order status|status of|show me order|view order/i.test(
      t,
    );
  const idVerb = extractOrderId(t) && /(show|check|where|status|track|view|my order)/i.test(t);
  return base || !!idVerb;
}
function isWhereTracking(t: string): boolean {
  return /where|track|tracking|shipped|deliver|eta|arrive/i.test(t);
}
function hasDamaged(t: string): boolean {
  return /damaged|broken|cracked|wrong item|defective|arrived damaged|not working|leaking/i.test(t);
}
function hasTicketAction(t: string): boolean {
  return /support ticket|open a ticket|file a ticket|create a ticket|create.*ticket|raise.*ticket|ticket for/i.test(t);
}
/** A bare "create/open a (support) ticket" with no stated issue. */
function hasBareTicketAction(t: string): boolean {
  const stripped = t
    .replace(/for this order|for that order|for this|for that|about this|about that/gi, " ")
    .replace(/\b(create|open|file|raise|start|new|a|an|the|me|my|please|can|you|could|support|ticket)\b/gi, " ")
    .replace(/[^a-zA-Z]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return hasTicketAction(t) && stripped.length < 6;
}
/** A customer asking about their OWN orders (not staff phrasing). */
function hasMyOrdersAction(t: string): boolean {
  return /\bwhat did i order|what (are|was) (my|our) orders?\b|\b(my|our) (order|orders|purchases|items|purchase history|order history)\b|\bmy order history\b/i.test(t);
}
/** True if the request is about the caller's OWN account (not a customer's). */
function isAboutSelf(t: string): boolean {
  return /\b(my|me|our) (orders?|tickets?|account|order)\b/i.test(t)
    || /\bwhere is my\b|\bcheck my\b|\brefund my\b|\bmy last\b/i.test(t);
}
function hasCustomerSearch(t: string): boolean {
  if (isAboutSelf(t)) return false;
  return /\b(which|whose|who is|find|look up|search|show me|get|tell me).{0,40}\b(customer|client|account)\b/i.test(t)
    || /\b(customer|client|account) (named|called|with|whose)\b/i.test(t);
}
function hasListOrders(t: string): boolean {
  if (isAboutSelf(t)) return false;
  return /\b(list|show|all) (the |open )?(recent )?orders\b/i.test(t)
    || /\borders?\b.{0,30}\b(for|of|from|by)\b.{0,30}\b(customer|client|account)\b/i.test(t);
}
function hasListTickets(t: string): boolean {
  if (isAboutSelf(t)) return false;
  return /\b(list|show) (the |all )?(open |active |recent )?tickets\b/i.test(t);
}
function hasUpdateTicket(t: string): boolean {
  return /\b(mark|move|resolve|close|reopen|update) (ticket |the ticket )?(TCK-\S+)?\b/i.test(t);
}
function extractTicketId(t: string): string | undefined {
  const m = t.match(/TCK-\d+[A-Za-z0-9]*/i);
  return m ? m[0].toUpperCase() : undefined;
}
/** "Refund ... for the customer named Jane" style phrasing. */
function hasRefundForCustomer(t: string): boolean {
  if (isAboutSelf(t)) return false;
  return hasRefundAction(t) &&
    /(customer|client|account)\s+(named|called|with email)|\brefund.{0,40}\bfor (a |the )?customer\b/i.test(t);
}
function isQuestion(t: string): boolean {
  return /(\?|what\b|how\b|when\b|why\b|can i|do you|is there|policy|how long)/i.test(t);
}

function deriveReason(t: string): string {
  if (/damaged|broken|wrong|defective|cracked/i.test(t)) return "Damaged or wrong item received";
  if (/cancel/i.test(t)) return "Order cancellation request";
  return "Customer requested refund";
}

function pickRefundTarget(orders: Order[]): Order | undefined {
  const sorted = [...orders].sort((a, b) => b.createdAt - a.createdAt);
  return sorted.find((o) => o.status !== "cancelled");
}
function pickLatestOrder(orders: Order[]): Order | undefined {
  return [...orders].sort((a, b) => b.createdAt - a.createdAt)[0];
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function itemsSummary(o: Order): string {
  const parts = o.items.map((i) => `${i.name} x${i.qty}`).join(", ");
  return parts;
}

function summarizeOrder(o: Order): string {
  const statusLine = `Order ${o.id} is ${o.status.replace(/_/g, " ")}.`;
  const total = `Total ${formatCents(o.total, o.currency)} (${o.currency}).`;
  const items = o.items.length ? `Items: ${itemsSummary(o)}.` : "";
  const delivered = o.deliveredAt ? ` Delivered on ${fmtDate(o.deliveredAt)}.` : "";
  const refundable =
    o.refundableAmount > 0
      ? ` Refundable remaining: ${formatCents(o.refundableAmount, o.currency)}.`
      : "";
  return [statusLine, total, items, delivered + refundable].filter(Boolean).join(" ");
}

function summarizeTracking(o: Order, t: TrackingStatus): string {
  const head = `Your order ${o.id} is ${t.status.replace(/_/g, " ")}.`;
  const last = t.events[t.events.length - 1];
  const latest = last
    ? `Latest update: ${last.description} in ${last.location} on ${fmtDateTime(last.at)}.`
    : "";
  const eta = t.eta ? `Estimated delivery: ${t.eta}.` : "";
  const tn = t.trackingNumber ? ` Tracking number: ${t.trackingNumber}.` : "";
  return [head, latest, eta, tn].filter(Boolean).join(" ");
}

function approvalText(r: {
  orderId: string;
  amount: number;
  currency: string;
  approvalId: string;
  message: string;
  customerName?: string;
}): string {
  const who = r.customerName ? ` for customer ${r.customerName}` : "";
  return (
    `A refund of ${formatCents(r.amount, r.currency)} on order ${r.orderId}${who} requires ` +
    `manager approval for your protection. I've created approval request ${r.approvalId} ` +
    `and it is now pending. ${r.message} Nothing has been refunded yet — I'll confirm ` +
    `as soon as it is approved.`
  );
}

/** The most recent customer found via search_customers (id + name), if any. */
function lastSearchCustomer(messages: LlmMessage[]): { id: string; name: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" && m.name === "search_customers") {
      const r = parseResult(m.content);
      const c = r?.data?.customers?.[0];
      if (c?.id) return { id: c.id, name: c.name ?? c.id };
    }
  }
  return undefined;
}

/** The most recently listed order (from list_orders or list_customer_orders). */
function lastListedOrder(messages: LlmMessage[]): Order | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" && (m.name === "list_orders" || m.name === "list_customer_orders")) {
      const r = parseResult(m.content);
      const orders: Order[] = r?.data?.orders ?? [];
      if (orders.length) return pickLatestOrder(orders);
    }
  }
  return undefined;
}

function summarizeOrders(orders: Order[], customerLabel?: string): string {
  if (!orders.length) {
    return customerLabel ? `No orders found for ${customerLabel}.` : "No orders found.";
  }
  const lines = orders
    .map((o) => {
      const cust = o.customerId ? ` (${o.customerId})` : "";
      return `- ${o.id} · ${o.status.replace(/_/g, " ")} · ${formatCents(o.total, o.currency)}${cust}`;
    })
    .join("\n");
  return `Here are ${orders.length} order${orders.length > 1 ? "s" : ""}${customerLabel ? ` for ${customerLabel}` : ""}:\n${lines}`;
}

function summarizeCustomers(customers: { id: string; name: string; email: string }[]): string {
  if (!customers.length) return "I couldn't find a matching customer.";
  const lines = customers.map((c) => `- ${c.name} · ${c.email} (${c.id})`).join("\n");
  return `Found ${customers.length} matching customer${customers.length > 1 ? "s" : ""}:\n${lines}`;
}

function ticketText(t: SupportTicket): string {
  return `I've opened support ticket ${t.id} (priority: ${t.priority}) titled "${t.subject}". Our team will follow up shortly. You can reference ${t.id} anytime.`;
}

function errorText(result: { ok: false; error: { code: string; message: string } }): string {
  const code = result.error.code;
  switch (code) {
    case "NOT_FOUND":
      return "I couldn't find that order on your account. Double-check the order number?";
    case "FORBIDDEN":
      return "I'm not able to access that record for this account.";
    case "ELIGIBILITY":
      return `I can't process that refund: ${result.error.message}`;
    case "DUPLICATE":
      return "That refund is already in progress, so I didn't create another one.";
    case "APPROVAL_REQUIRED":
      return "That action needs approval and has been submitted for review.";
    case "VALIDATION":
      return `I couldn't do that because ${result.error.message.toLowerCase()}. Please check the details and try again.`;
    default:
      return "Something went wrong while handling that request. Please try again.";
  }
}

function finalNoEligible(orders: Order[]): LlmPlan {
  if (!orders.length)
    return { kind: "final", text: "I couldn't find any orders on your account." };
  const last = pickLatestOrder(orders)!;
  return {
    kind: "final",
    text: `I looked at your orders, but the most recent one (${last.id}) isn't eligible for a refund right now (status: ${last.status.replace(/_/g, " ")}). Would you like me to open a support ticket about it?`,
  };
}

function parseResult(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Best-effort extraction of a customer's name from staff phrasing. */
function extractCustomerName(t: string): string | undefined {
  // Prefer an explicit "customer/client/account [named|called] <Name>" pattern.
  const explicit = t.match(
    /\b(?:customer|client|account)\s+(?:named\s+|called\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/,
  );
  if (explicit) return explicit[1].trim();

  // Fallback: a capitalized personal name, skipping common action verbs/stops.
  const stop =
    /\b(who|which|what|find|look|search|show|check|create|open|file|refund|list|mark|resolve|close|update|the|a|an|customer|client|account|named|called|with|for|on|in|and|ord|cust|support|ticket|orders|order)\b/i;
  const runs = t.match(/\b[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+){0,3}\b/g) ?? [];
  for (const run of runs) {
    const words = run.split(" ").filter((w) => !stop.test(` ${w} `));
    if (words.length >= 1 && words.join(" ").length >= 3) return words.join(" ").trim();
  }
  return undefined;
}

/** Staff intent detection (support/admin only - the loop enforces this). */
function staffFirstTurn(text: string, messages: LlmMessage[]): LlmPlan | undefined {
  // "Refund ... for the customer named Jane (on ORD-...)"
  if (hasRefundForCustomer(text)) {
    const name = extractCustomerName(text);
    const id = extractOrderId(text);
    const amount = extractAmountCents(text);
    if (id) {
      // The order unambiguously identifies its owner; the tool validates the
      // refund against the order's actual customer.
      const args: Record<string, unknown> = { orderId: id, reason: deriveReason(text) };
      if (amount !== undefined) args.amount = amount;
      return { kind: "tool", tool: "request_refund", args };
    }
    if (name) {
      return { kind: "tool", tool: "search_customers", args: { query: name } };
    }
  }
  // "Who is / find / search customer <name>"
  if (hasCustomerSearch(text)) {
    let name = extractCustomerName(text);
    if (!name) {
      name = text
        .replace(/please|can you|could you|show me|tell me|find|look up|search|who is|which|what|the|a|an|customer|client|account|named|called/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    if (name && name.length >= 2) return { kind: "tool", tool: "search_customers", args: { query: name } };
  }
  // "Create/open/file a ticket for the customer <name>" -> find the customer first.
  if ((hasTicketAction(text) || hasDamaged(text)) && /(customer|client|account)/i.test(text)) {
    const name = extractCustomerName(text);
    if (name) return { kind: "tool", tool: "search_customers", args: { query: name } };
  }
  // "List orders (for customer <name>)" / "show all orders"
  if (hasListOrders(text) && /(customer|client|account)/i.test(text)) {
    const name = extractCustomerName(text);
    const cust = lastSearchCustomer(messages);
    if (name) return { kind: "tool", tool: "search_customers", args: { query: name } };
    if (cust) return { kind: "tool", tool: "list_orders", args: { customerId: cust.id, limit: 10 } };
  }
  // "List tickets"
  if (hasListTickets(text)) {
    return { kind: "tool", tool: "list_tickets", args: {} };
  }
  // "Mark ticket TCK-... resolved"
  if (hasUpdateTicket(text)) {
    const ticketId = extractTicketId(text) ?? extractTicketIdFromContext(messages);
    if (!ticketId) {
      return { kind: "final", text: "Which ticket should I update? Give me the ticket id (TCK-...)." };
    }
    const status = /resolve|resolved/i.test(text)
      ? "resolved"
      : /close|closed/i.test(text)
        ? "closed"
        : /reopen|open/i.test(text)
          ? "open"
          : /progress/i.test(text)
            ? "in_progress"
            : undefined;
    const args: Record<string, unknown> = { ticketId };
    if (status) args.status = status;
    return { kind: "tool", tool: "update_support_ticket", args };
  }
  return undefined;
}

function extractTicketIdFromContext(messages: LlmMessage[]): string | undefined {
  const texts: string[] = [];
  for (const m of messages.slice(-6)) {
    if (m.role === "assistant" || m.role === "user") texts.push(m.content ?? "");
  }
  const ids = texts.join(" ").match(/TCK-\d+[A-Za-z0-9]*/gi);
  return ids && ids.length ? ids[ids.length - 1].toUpperCase() : undefined;
}

/** First-turn intent detection. */
function firstTurn(text: string, messages: LlmMessage[]): LlmPlan {
  // Role comes from the system prompt ("role: admin|support_agent|customer").
  const role = (messages.find((m) => m.role === "system")?.content ?? "").match(/role: (\w+)/)?.[1];
  if (role === "support_agent" || role === "admin") {
    const plan = staffFirstTurn(text, messages);
    if (plan) return plan;
  }
  if (hasRefundAction(text)) {
    const id = extractOrderId(text);
    const amount = extractAmountCents(text);
    if (id) {
      const args: Record<string, unknown> = { orderId: id, reason: deriveReason(text) };
      if (amount !== undefined) args.amount = amount;
      return { kind: "tool", tool: "request_refund", args };
    }
    // "refund my last order" -> find the customer's orders first
    return { kind: "tool", tool: "list_customer_orders", args: {} };
  }

  // "I want to return my order/item" -> return request, not a policy question.
  // Route it through the same refund flow (the 30-day return window applies).
  if (hasReturnAction(text)) {
    const id = extractOrderId(text);
    if (id) {
      return { kind: "tool", tool: "request_refund", args: { orderId: id, reason: deriveReason(text) } };
    }
    return { kind: "tool", tool: "list_customer_orders", args: {} };
  }

  // "I want to cancel my order" -> open a cancellation ticket (linked to the
  // mentioned order when present) instead of falling back to generic help.
  if (hasCancelAction(text)) {
    const id = extractOrderId(text) ?? extractOrderIdFromContext(messages);
    const args: Record<string, unknown> = {
      subject: "Order cancellation request",
      description: text,
      priority: priorityFromText(text),
    };
    if (id) args.orderId = id;
    return { kind: "tool", tool: "create_support_ticket", args };
  }

  if (hasOrderAction(text)) {
    const id = extractOrderId(text);
    if (id) return { kind: "tool", tool: "get_order", args: { orderId: id } };
    // "Where is my order?" with no id: list the customer's orders, then the
    // afterTool step resolves tracking for the most relevant one.
    return { kind: "tool", tool: "list_customer_orders", args: {} };
  }

  // "What did I order?" / "My orders" / "Order history" — a pure listing ask.
  // Placed before the policy/help fallback so it is never dropped.
  if (hasMyOrdersAction(text)) {
    return { kind: "tool", tool: "list_customer_orders", args: {} };
  }

  if (hasDamaged(text)) {
    const id = extractOrderId(text) ?? extractOrderIdFromContext(messages);
    const args: Record<string, unknown> = {
      subject: "Damaged or wrong item received",
      description: text,
      priority: "high",
    };
    if (id) args.orderId = id;
    return { kind: "tool", tool: "create_support_ticket", args };
  }

  if (hasTicketAction(text)) {
    const id = extractOrderId(text) ?? extractOrderIdFromContext(messages);
    // A bare "create a support ticket" with no stated issue: don't create a
    // ticket titled "Support request". Ask what's wrong first.
    if (hasBareTicketAction(text)) {
      return {
        kind: "final",
        text: "Happy to open a ticket. What's the issue? A short description helps the team pick it up faster (e.g. \"arrived damaged\", \"wrong item\", \"can't log in\").",
      };
    }
    const args: Record<string, unknown> = {
      subject: subjectFromText(text),
      description: text,
      priority: priorityFromText(text),
    };
    if (id) args.orderId = id;
    return { kind: "tool", tool: "create_support_ticket", args };
  }

  const policy = lookupPolicy(text);
  if (policy && isQuestion(text)) {
    return { kind: "tool", tool: "lookup_policy", args: { query: text } };
  }

  return {
    kind: "final",
    text: "I can help with order status, tracking, support tickets, refunds, and company policy. What would you like to do?",
  };
}

/**
 * Derive a concise, meaningful ticket subject from the request. Strips the
 * "please create a support ticket ..." wrapper and keeps the actual issue.
 * Falls back to a topic-based default (e.g. damaged, cancellation) rather than
 * the generic "Support request" when the message has a recognizable theme.
 */
function subjectFromText(t: string): string {
  const clean = t
    .replace(/support ticket|open a ticket|file a ticket|create a ticket|create.*?ticket|raise.*?ticket|for this order|for that order|about this|about that/gi, " ")
    .replace(/^(please|can you|could you|i would like to|i want to|i'd like to)\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length >= 4 && clean.length <= 140) {
    // Title-case the first word for a tidy subject line.
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  if (/damaged|broken|cracked|defective|not working/i.test(t)) return "Damaged or defective item";
  if (/wrong item|wrong product/i.test(t)) return "Wrong item received";
  if (/cancel/i.test(t)) return "Cancellation request";
  if (/lost|missing|didn'?t arrive|never arrived/i.test(t)) return "Lost or missing shipment";
  if (/login|password|account access/i.test(t)) return "Account access issue";
  return "General support request";
}
function priorityFromText(t: string): "low" | "medium" | "high" {
  if (/urgent|asap|high|damaged|broken|emergency/i.test(t)) return "high";
  if (/low|minor|someday/i.test(t)) return "low";
  return "medium";
}

/** Decide the next step after a tool result. */
function afterTool(messages: LlmMessage[]): LlmPlan {
  const userText = lastUserText(messages);
  const toolMsg = lastToolMsg(messages)!;
  const name = toolMsg.name ?? "";
  const result = parseResult(toolMsg.content);

  if (!result.ok) {
    // A tool error. Report it accurately; do not fabricate success.
    if (name === "get_order" || name === "list_customer_orders") {
      return { kind: "final", text: errorText(result) };
    }
    return { kind: "final", text: errorText(result) };
  }

  switch (name) {
    case "list_customer_orders": {
      const orders: Order[] = result.data?.orders ?? [];
      if (hasRefundAction(userText) || hasReturnAction(userText)) {
        const target = pickRefundTarget(orders);
        if (!target) return finalNoEligible(orders);
        return {
          kind: "tool",
          tool: "request_refund",
          args: { orderId: target.id, reason: deriveReason(userText) },
        };
      }
      // "What did I order?" -> show the full list (most recent last), not just one.
      // Tracking phrasing ("where is my order") must keep flowing to
      // get_tracking_status below, so it is excluded here.
      if (hasMyOrdersAction(userText) && !isWhereTracking(userText)) {
        if (!orders.length)
          return { kind: "final", text: "I couldn't find any orders on your account." };
        const cards = orders.slice(0, 5).map((o) => ({ kind: "order" as const, order: o }));
        return {
          kind: "final",
          text: `Here are your ${orders.length} order${orders.length > 1 ? "s" : ""} (most recent last):\n${orders
            .map((o) => `- ${o.id} · ${o.status.replace(/_/g, " ")} · ${formatCents(o.total, o.currency)}`)
            .join("\n")}`,
          cards,
        };
      }
      const target = pickLatestOrder(orders);
      if (!target) return { kind: "final", text: "I couldn't find any orders on your account." };
      if (isWhereTracking(userText))
        return { kind: "tool", tool: "get_tracking_status", args: { orderId: target.id } };
      return { kind: "tool", tool: "get_order", args: { orderId: target.id } };
    }
    case "get_order": {
      const o: Order = result.data.order;
      if (["processing", "shipped", "delivered"].includes(o.status)) {
        return { kind: "tool", tool: "get_tracking_status", args: { orderId: o.id } };
      }
      return { kind: "final", text: summarizeOrder(o), cards: [{ kind: "order", order: o }] };
    }
    case "get_tracking_status": {
      const o: Order = result.data.order;
      const t: TrackingStatus = result.data.tracking;
      return {
        kind: "final",
        text: summarizeTracking(o, t),
        cards: [{ kind: "order", order: o, tracking: t }],
      };
    }
    case "request_refund": {
      const r = result.data;
      if (r.status === "pending_approval") {
        return {
          kind: "final",
          text: approvalText(r),
          cards: [
            {
              kind: "refund",
              status: "pending_approval",
              orderId: r.orderId,
              amount: r.amount,
              currency: r.currency,
              approvalId: r.approvalId,
              customerName: r.customerName,
              message: r.message,
            },
          ],
        };
      }
      return { kind: "final", text: errorText(result) };
    }
    case "search_customers": {
      const customers = result.data.customers;
      const cust = customers[0];
      if (!cust) return { kind: "final", text: summarizeCustomers(customers) };
      // Staff flow: after finding a customer, continue toward the original intent.
      // Ordered by specificity so e.g. "ticket for Alex: order arrived damaged"
      // is not mis-read as an order lookup.
      if (hasRefundAction(userText)) {
        return { kind: "tool", tool: "list_orders", args: { customerId: cust.id, limit: 5 } };
      }
      if (hasTicketAction(userText) || hasDamaged(userText)) {
        const args: Record<string, unknown> = {
          customerId: cust.id,
          subject: subjectFromText(userText) || "Support request",
          description: userText,
          priority: priorityFromText(userText),
        };
        const oid = extractOrderId(userText) ?? extractOrderIdFromContext(messages);
        if (oid) args.orderId = oid;
        return { kind: "tool", tool: "create_support_ticket", args };
      }
      if (hasListOrders(userText)) {
        return { kind: "tool", tool: "list_orders", args: { customerId: cust.id, limit: 10 } };
      }
      return { kind: "final", text: summarizeCustomers(customers) };
    }
    case "list_orders": {
      const orders: Order[] = result.data.orders ?? [];
      if (hasRefundAction(userText)) {
        const cust = lastSearchCustomer(messages);
        const target = pickRefundTarget(orders);
        if (!target)
          return { kind: "final", text: `No orders found to refund for ${cust?.name ?? "that customer"}.` };
        // The order identifies its owner; the tool validates the refund against
        // the order's actual customer. No customerId needed.
        const args: Record<string, unknown> = { orderId: target.id, reason: deriveReason(userText) };
        const amt = extractAmountCents(userText);
        if (amt !== undefined) args.amount = amt;
        return { kind: "tool", tool: "request_refund", args };
      }
      const cust = lastSearchCustomer(messages);
      return {
        kind: "final",
        text: summarizeOrders(orders, cust?.name),
        cards: orders.slice(0, 1).map((o) => ({ kind: "order" as const, order: o })),
      };
    }
    case "list_tickets": {
      const tickets: SupportTicket[] = result.data.tickets ?? [];
      if (!tickets.length) return { kind: "final", text: "No tickets found." };
      const lines = tickets
        .map((t) => `- ${t.id} · ${t.status.replace(/_/g, " ")} · ${t.priority} · ${t.subject}`)
        .join("\n");
      return {
        kind: "final",
        text: `Here are ${tickets.length} ticket${tickets.length > 1 ? "s" : ""}:\n${lines}`,
      };
    }
    case "update_support_ticket": {
      const t: SupportTicket = result.data.ticket;
      return {
        kind: "final",
        text: `Ticket ${t.id} is now ${t.status.replace(/_/g, " ")} (priority: ${t.priority}).`,
        cards: [{ kind: "ticket", ticket: t }],
      };
    }
    case "create_support_ticket": {
      const t: SupportTicket = result.data.ticket;
      return { kind: "final", text: ticketText(t), cards: [{ kind: "ticket", ticket: t }] };
    }
    case "lookup_policy": {
      const p = result.data;
      const cite = ` (Source: ${p.citation?.title ?? "company policy"})`;
      return { kind: "final", text: `${p.text}${cite}` };
    }
    default:
      return {
        kind: "final",
        text: "I wasn't sure how to continue. Could you rephrase your request?",
      };
  }
}

export class MockLlmClient implements LlmClient {
  readonly provider = "mock" as const;
  async plan(messages: LlmMessage[], _tools: LlmTool[]): Promise<LlmPlan> {
    if (lastToolMsg(messages)) return afterTool(messages);
    return firstTurn(lastUserText(messages), messages);
  }
}

export function createMockLlm(): LlmClient {
  return new MockLlmClient();
}
