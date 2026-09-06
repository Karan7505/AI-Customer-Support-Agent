import type { Repo } from "@/db/repos";
import { genId } from "./ids";
import { Errors } from "./errors";
import { nowMs, formatCents } from "./util";
import type {
  AgentCard,
  Order,
  Principal,
  Refund,
  SupportTicket,
  TicketPriority,
  ToolResult,
  TrackingStatus,
} from "./types";
import {
  CreateSupportTicketInput,
  GetOrderInput,
  GetTrackingStatusInput,
  ListCustomerOrdersInput,
  ListOrdersInput,
  ListTicketsInput,
  LookupPolicyInput,
  RequestRefundInput,
  SearchCustomersInput,
  UpdateSupportTicketInput,
} from "./schemas";
import type { LlmTool } from "./llm";
import { isStaff } from "./policy";
import { lookupPolicy } from "./knowledge";
import {
  checkRefundEligibility,
  refundIdempotencyKey,
  refundRequestKey,
} from "./refunds";
import { createApproval, mapApproval } from "./approvals";
import type { Auditor } from "./audit";

export interface ToolContext {
  repo: Repo;
  auditor: Auditor;
  principal: Principal;
  conversationId?: string | null;
}

type ToolHandler = (ctx: ToolContext, args: any) => Promise<ToolResult>;

interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  internal: boolean;
  handler: ToolHandler;
}

const orderIdParam = {
  type: "string",
  pattern: "^[A-Za-z]{2,6}-\\d+$",
  description: "Order id, e.g. ORD-1001",
};

function validate(schema: any, args: any) {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw Errors.validation(
      "Invalid arguments: " + parsed.error.issues.map((i: any) => i.message).join("; "),
      parsed.error.issues,
    );
  }
  return parsed.data;
}

// ---- helpers --------------------------------------------------------------

/**
 * Load an order the caller may act on:
 *  - customer: must be their own order (unknown and foreign both return
 *    NOT_FOUND, so cross-customer existence is not leaked);
 *  - staff (support/admin): any order in the system.
 */
function findOrderFor(ctx: ToolContext, orderId: string): Order {
  const order = ctx.repo.getOrder(orderId);
  if (!order) throw Errors.notFound("Order");
  if (!isStaff(ctx.principal.role) && order.customerId !== ctx.principal.id) {
    throw Errors.notFound("Order");
  }
  return order;
}

/**
 * Resolve the customer a refund targets:
 *  - customer: always themselves; any other customerId is rejected;
 *  - staff: the customerId argument is mandatory (they act on someone's behalf).
 */
function resolveRefundCustomer(ctx: ToolContext, order: Order, requested?: string): string {
  if (isStaff(ctx.principal.role)) {
    // The order unambiguously identifies its owner; refund targets that owner.
    // If a customerId is explicitly given, it must be a real customer that owns
    // the order (prevents staff mis-targeting a different account).
    if (requested) {
      const c = ctx.repo.getCustomer(requested);
      if (!c || c.role !== "customer") throw Errors.notFound("Customer");
      if (c.id !== order.customerId) {
        throw Errors.eligibility("That order belongs to a different customer.");
      }
      return c.id;
    }
    return order.customerId;
  }
  if (requested && requested !== ctx.principal.id) {
    // Never let a customer target someone else's account.
    throw Errors.forbidden("You can only request refunds on your own account.");
  }
  return ctx.principal.id;
}

function mapTicket(row: any): SupportTicket {
  return {
    id: row.id,
    customerId: row.customerId,
    orderId: row.orderId,
    subject: row.subject,
    description: row.description,
    priority: row.priority as TicketPriority,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Resolve the customer a support ticket is for (staff may target any customer). */
function resolveTicketCustomer(ctx: ToolContext, order: Order | null, requested?: string): string {
  if (isStaff(ctx.principal.role)) {
    const cid = requested ?? order?.customerId ?? undefined;
    if (!cid) {
      throw Errors.validation("Staff must specify the customer (customerId) the ticket is for.");
    }
    const c = ctx.repo.getCustomer(cid);
    if (!c || c.role !== "customer") throw Errors.notFound("Customer");
    if (order && order.customerId !== c.id) {
      throw Errors.eligibility("The referenced order belongs to a different customer.");
    }
    return c.id;
  }
  if (requested && requested !== ctx.principal.id) {
    throw Errors.forbidden("You can only create tickets on your own account.");
  }
  return order ? order.customerId : ctx.principal.id;
}

/** Deterministic, realistic mock tracking derived from the order. */
function mockTracking(order: Order): TrackingStatus {
  const base = order.createdAt;
  const day = 24 * 60 * 60 * 1000;
  const events: TrackingStatus["events"] = [
    { location: "Warehouse", description: "Order packed and ready for pickup", at: base + 1 * day },
  ];
  const status = order.status;
  if (status === "shipped" || status === "delivered") {
    events.push({ location: "Distribution Center", description: "Picked up by carrier", at: base + 2 * day });
  }
  if (status === "shipped") {
    events.push({
      location: "In Transit",
      description: "In transit to your area",
      at: Math.min(nowMs(), base + 3 * day),
    });
    return {
      orderId: order.id,
      trackingNumber: order.trackingNumber ?? `TRK-${order.id.replace("ORD-", "")}-1`,
      // Track the order's canonical status so UI/eval wording is consistent.
      status: order.status,
      events,
      eta: new Date(base + 6 * day).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      delivered: false,
    };
  }
  if (status === "delivered") {
    events.push({
      location: "Local Facility",
      description: "Out for delivery",
      at: base + 4 * day,
    });
    events.push({
      location: order.shippingAddress.city,
      description: "Delivered",
      at: order.deliveredAt ?? base + 5 * day,
    });
    return {
      orderId: order.id,
      trackingNumber: order.trackingNumber ?? `TRK-${order.id.replace("ORD-", "")}-1`,
      status: "delivered",
      events,
      eta: null,
      delivered: true,
    };
  }
  return {
    orderId: order.id,
    trackingNumber: order.trackingNumber,
    status: status,
    events,
    eta:
      status === "processing" || status === "pending"
        ? new Date(base + 7 * day).toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : null,
    delivered: false,
  };
}

// ---- tool handlers --------------------------------------------------------

const get_order: ToolSpec = {
  name: "get_order",
  description: "Look up a single order by id for the signed-in customer. Read-only.",
  parameters: {
    type: "object",
    properties: { orderId: orderIdParam },
    required: ["orderId"],
    additionalProperties: false,
  },
  internal: false,
  handler: async (ctx, raw) => {
    const { orderId } = validate(GetOrderInput, raw);
    const order = findOrderFor(ctx, orderId);
    return { ok: true, data: { order } };
  },
};

const list_customer_orders: ToolSpec = {
  name: "list_customer_orders",
  description:
    "List the orders that belong to the signed-in customer (most recent last). Read-only. Never returns another customer's orders.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  internal: false,
  handler: async (ctx) => {
    validate(ListCustomerOrdersInput, {});
    const orders = ctx.repo.getOrdersByCustomer(ctx.principal.id);
    return { ok: true, data: { orders } };
  },
};

const get_tracking_status: ToolSpec = {
  name: "get_tracking_status",
  description: "Return live mock shipping/tracking status for the signed-in customer's order. Read-only.",
  parameters: {
    type: "object",
    properties: { orderId: orderIdParam },
    required: ["orderId"],
    additionalProperties: false,
  },
  internal: false,
  handler: async (ctx, raw) => {
    const { orderId } = validate(GetTrackingStatusInput, raw);
    const order = findOrderFor(ctx, orderId);
    const tracking = mockTracking(order);
    return { ok: true, data: { order, tracking } };
  },
};

const create_support_ticket: ToolSpec = {
  name: "create_support_ticket",
  description: "Open a support ticket for the signed-in customer. Persists to the database.",
  parameters: {
    type: "object",
    properties: {
      orderId: { ...orderIdParam, description: "Optional related order id" },
      customerId: {
        type: "string",
        description: "Target customer (staff only; customers are locked to themselves).",
      },
      subject: { type: "string", minLength: 3, maxLength: 140 },
      description: { type: "string", minLength: 3, maxLength: 2000 },
      priority: { type: "string", enum: ["low", "medium", "high"] },
    },
    required: ["subject", "description", "priority"],
    additionalProperties: false,
  },
  internal: false,
  handler: async (ctx, raw) => {
    const args = validate(CreateSupportTicketInput, raw);
    let orderId: string | null = null;
    let order: Order | null = null;
    if (args.orderId) {
      order = findOrderFor(ctx, args.orderId); // ownership enforced here
      orderId = order.id;
    }
    const customerId = resolveTicketCustomer(ctx, order, args.customerId as string | undefined);
    const id = genId("TCK");
    const t = nowMs();
    const row = ctx.repo.createTicket({
      id,
      customerId,
      orderId,
      subject: args.subject,
      description: args.description,
      priority: args.priority,
      status: "open",
      createdAt: t,
      updatedAt: t,
    });
    const ticket = mapTicket(row);
    ctx.auditor.log(
      { actor: ctx.principal, conversationId: ctx.conversationId },
      "ticket.created",
      { toolName: "create_support_ticket", arguments: args, result: { ticketId: id } },
    );
    return { ok: true, data: { ticket } };
  },
};

const lookup_policy: ToolSpec = {
  name: "lookup_policy",
  description:
    "Look up general company policy (returns, refunds, shipping, etc.). Returns text with a source citation. For general policy only, never customer-specific data.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", minLength: 2, maxLength: 500 } },
    required: ["query"],
    additionalProperties: false,
  },
  internal: false,
  handler: async (ctx, raw) => {
    const { query } = validate(LookupPolicyInput, raw);
    const ans = lookupPolicy(query);
    if (!ans) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "No matching policy found. Try asking about returns, refunds, shipping, or damaged items.",
        },
      };
    }
    ctx.auditor.log(
      { actor: ctx.principal, conversationId: ctx.conversationId },
      "policy.lookup",
      { toolName: "lookup_policy", arguments: { query }, result: { topic: ans.topic } },
    );
    return { ok: true, data: { topic: ans.topic, text: ans.text, citation: ans.citation } };
  },
};

const request_refund: ToolSpec = {
  name: "request_refund",
  description:
    "Request a refund for the signed-in customer's order. Runs ownership, eligibility, amount and duplicate checks, then creates an approval request. It NEVER executes a refund itself.",
  parameters: {
    type: "object",
    properties: {
      orderId: orderIdParam,
      amount: {
        type: "number",
        description: "Refund amount in CENTS (e.g. $20.00 = 2000). Optional; defaults to the remaining refundable amount.",
      },
      reason: { type: "string", minLength: 3, maxLength: 300 },
      customerId: {
        type: "string",
        description: "Target customer, REQUIRED for staff (support/admin); customers refund their own account and must omit this.",
      },
    },
    required: ["orderId", "reason"],
    additionalProperties: false,
  },
  internal: false,
  handler: async (ctx, raw) => {
    const args = validate(RequestRefundInput, raw);
    const order = findOrderFor(ctx, args.orderId);
    const customerId = resolveRefundCustomer(ctx, order, args.customerId);
    const amount = args.amount ?? order.refundableAmount;
    const normalizedAmount = Math.round(amount);

    // Duplicate guard: an open (non-terminal) refund already in flight for this order.
    const open = ctx.repo.getOpenRefundForOrder(order.id);
    if (open) {
      const existingAp = open.approvalId ? ctx.repo.getApproval(open.approvalId) : undefined;
      return {
        ok: false,
        error: {
          code: "DUPLICATE",
          message: `A refund is already in progress for this order (status: ${open.status}${existingAp ? `, approval ${open.approvalId}` : ""}).`,
          details: { existingRefundId: open.id, approvalId: open.approvalId ?? null },
        },
      };
    }

    const eligibility = checkRefundEligibility(order, normalizedAmount);
    if (!eligibility.allowed) {
      return {
        ok: false,
        error: { code: "ELIGIBILITY", message: eligibility.reason ?? "Not eligible", details: eligibility.details },
      };
    }

    // Create or reuse the approval. Never execute here.
    // NOTE: keys use the TARGET customer (order.customerId), not the actor, so
    // staff-initiated refunds dedupe/idempotize correctly per affected account.
    const approvalIdempotencyKey = refundRequestKey({
      customerId: order.customerId,
      orderId: order.id,
      amountCents: normalizedAmount,
      reason: args.reason,
    });
    const approval = createApproval(ctx.repo, ctx.auditor, {
      requestedBy: ctx.principal,
      actionType: "refund",
      toolName: "process_refund",
      arguments: {
        orderId: order.id,
        amount: normalizedAmount,
        reason: args.reason,
        customerId: order.customerId,
      },
      riskLevel: "high",
      orderId: order.id,
      amountCents: normalizedAmount,
      idempotencyKey: approvalIdempotencyKey,
      conversationId: ctx.conversationId,
    });

    // Persist a refund record in 'pending_approval' state so the status is
    // queryable and the action is idempotent end-to-end.
    const refundId = genId("REF");
    const t = nowMs();
    const refundKey = refundIdempotencyKey({
      customerId: order.customerId,
      orderId: order.id,
      approvalId: approval.id,
    });
    ctx.repo.createRefund({
      id: refundId,
      orderId: order.id,
      customerId: order.customerId,
      amount: normalizedAmount,
      reason: args.reason,
      status: "pending_approval",
      approvalId: approval.id,
      idempotencyKey: refundKey,
      createdAt: t,
      processedAt: null,
    });

    ctx.auditor.log(
      { actor: ctx.principal, conversationId: ctx.conversationId, approvalId: approval.id },
      "refund.requested",
      {
        toolName: "request_refund",
        arguments: { orderId: order.id, amount: normalizedAmount, reason: args.reason },
        result: { approvalId: approval.id, refundId, status: "pending_approval" },
      },
    );

    const targetCustomer = ctx.repo.getCustomer(order.customerId);
    return {
      ok: true,
      data: {
        status: "pending_approval",
        approvalId: approval.id,
        refundId,
        orderId: order.id,
        customerId: order.customerId,
        customerName: targetCustomer?.name ?? order.customerId,
        amount: normalizedAmount,
        currency: order.currency,
        message: "Refund is pending approval. No money has moved yet.",
      },
    };
  },
};

const search_customers: ToolSpec = {
  name: "search_customers",
  description:
    "Search customers by name, email, or id. Staff only. Use to find the account a request is about before viewing their orders or tickets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 2, maxLength: 120, description: "Name, email, or id fragment" },
      limit: { type: "number", minimum: 1, maximum: 25 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  internal: false,
  handler: async (ctx, raw) => {
    const { query, limit } = validate(SearchCustomersInput, raw);
    const rows = ctx.repo.searchCustomers(query, limit ?? 10);
    const customers = rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      customer: r.name, // stable reference for follow-up ("for the customer <name>")
      createdAt: r.createdAt,
    }));
    return { ok: true, data: { customers } };
  },
};

const list_orders: ToolSpec = {
  name: "list_orders",
  description:
    "List orders, optionally filtered by customer and/or status. Staff only (customers use list_customer_orders).",
  parameters: {
    type: "object",
    properties: {
      customerId: { type: "string", minLength: 4, maxLength: 32, description: "Filter to one customer" },
      status: {
        type: "string",
        enum: ["pending", "processing", "shipped", "delivered", "cancelled", "refunded", "partially_refunded"],
      },
      limit: { type: "number", minimum: 1, maximum: 100 },
    },
    required: [],
    additionalProperties: false,
  },
  internal: false,
  handler: async (ctx, raw) => {
    const args = validate(ListOrdersInput, raw);
    const orders = ctx.repo.searchOrders({
      customerId: args.customerId,
      status: args.status,
      limit: args.limit ?? 10,
    });
    return { ok: true, data: { orders } };
  },
};

const list_tickets: ToolSpec = {
  name: "list_tickets",
  description:
    "List support tickets, optionally filtered by customer and/or status. Staff only.",
  parameters: {
    type: "object",
    properties: {
      customerId: { type: "string", minLength: 4, maxLength: 32, description: "Filter to one customer" },
      status: { type: "string", enum: ["open", "in_progress", "resolved", "closed"] },
      limit: { type: "number", minimum: 1, maximum: 100 },
    },
    required: [],
    additionalProperties: false,
  },
  internal: false,
  handler: async (ctx, raw) => {
    const args = validate(ListTicketsInput, raw);
    const rows = ctx.repo.listTickets({
      customerId: args.customerId,
      status: args.status,
      limit: args.limit ?? 15,
    });
    const tickets = rows.map(mapTicket);
    return { ok: true, data: { tickets } };
  },
};

const update_support_ticket: ToolSpec = {
  name: "update_support_ticket",
  description:
    "Update a support ticket's status/priority or append a handling note. Staff only.",
  parameters: {
    type: "object",
    properties: {
      ticketId: { type: "string", minLength: 4, maxLength: 32, description: "Ticket id, e.g. TCK-..." },
      status: { type: "string", enum: ["open", "in_progress", "resolved", "closed"] },
      priority: { type: "string", enum: ["low", "medium", "high"] },
      note: { type: "string", minLength: 3, maxLength: 500 },
    },
    required: ["ticketId"],
    additionalProperties: false,
  },
  internal: false,
  handler: async (ctx, raw) => {
    const args = validate(UpdateSupportTicketInput, raw);
    const existing = ctx.repo.getTicket(args.ticketId);
    if (!existing) throw Errors.notFound("Ticket");
    const patch: { status?: string; priority?: string; updatedAt: number } = { updatedAt: nowMs() };
    if (args.status) patch.status = args.status;
    if (args.priority) patch.priority = args.priority;
    ctx.repo.updateTicket(args.ticketId, patch);
    const updated = ctx.repo.getTicket(args.ticketId)!;
    const ticket = mapTicket(updated);
    ctx.auditor.log(
      { actor: ctx.principal, conversationId: ctx.conversationId },
      "ticket.updated",
      { toolName: "update_support_ticket", arguments: args, result: { ticketId: ticket.id, status: ticket.status } },
    );
    return { ok: true, data: { ticket } };
  },
};

export const TOOL_SPECS: ToolSpec[] = [
  get_order,
  list_customer_orders,
  get_tracking_status,
  create_support_ticket,
  lookup_policy,
  request_refund,
  search_customers,
  list_orders,
  list_tickets,
  update_support_ticket,
];

export function getToolSpec(name: string): ToolSpec | undefined {
  return TOOL_SPECS.find((t) => t.name === name);
}

/** Names of tools that can be exposed to a principal (excludes internal). */
export function visibleToolNames(_role: string): string[] {
  return TOOL_SPECS.filter((t) => !t.internal).map((t) => t.name);
}

export function toolSchemaFor(names: string[]): LlmTool[] {
  return TOOL_SPECS.filter((t) => !t.internal && names.includes(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/**
 * Execute a (non-internal) tool with full input validation.
 * Unknown/internal tools throw (the loop maps them to a rejection).
 * Handler validation/business failures are returned as a structured error
 * envelope so the agent can respond accurately instead of crashing.
 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const spec = getToolSpec(name);
  if (!spec || spec.internal) {
    throw Errors.tool(`Unknown or internal tool: ${name}`);
  }
  try {
    return await spec.handler(ctx, args);
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && "message" in e) {
      const err = e as { code: string; message: string; details?: unknown };
      return { ok: false, error: { code: err.code, message: err.message, details: err.details } };
    }
    return { ok: false, error: { code: "TOOL_ERROR", message: e instanceof Error ? e.message : String(e) } };
  }
}

export type { AgentCard, Refund };
