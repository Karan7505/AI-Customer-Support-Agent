import { and, asc, desc, eq, like, or } from "drizzle-orm";
import type { AppDatabase } from "./client";
import * as s from "./schema";
import { parseJson } from "@/lib/util";
import type { Order, OrderItem, Principal, ShippingAddress } from "@/lib/types";

/** Parse the JSON columns back into domain objects. */
function mapOrder(row: s.OrderRow): Order {
  return {
    id: row.id,
    customerId: row.customerId,
    status: row.status as Order["status"],
    total: row.total,
    currency: row.currency,
    items: parseJson<OrderItem[]>(row.items, []),
    shippingAddress: parseJson<ShippingAddress>(row.shippingAddress, {
      line1: "",
      city: "",
      state: "",
      postalCode: "",
      country: "",
    }),
    trackingNumber: row.trackingNumber,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    refundableAmount: row.refundableAmount,
  };
}

export interface Repo {
  // customers
  getCustomer: (id: string) => s.CustomerRow | undefined;
  getCustomerByEmail: (email: string) => s.CustomerRow | undefined;
  createCustomer: (c: {
    id: string;
    name: string;
    email: string;
    passwordHash: string;
    role: s.Role;
    createdAt: number;
  }) => void;
  listStaff: () => s.CustomerRow[];
  searchCustomers: (query: string, limit?: number) => s.CustomerRow[];

  // orders
  getOrder: (id: string) => Order | undefined;
  getOrderRow: (id: string) => s.OrderRow | undefined;
  getOrdersByCustomer: (customerId: string) => Order[];
  searchOrders: (f: { customerId?: string; status?: string; limit?: number }) => Order[];
  getLatestOrder: (customerId: string) => Order | undefined;
  updateOrderRefundState: (
    id: string,
    refundableAmount: number,
    status: string,
  ) => void;

  // tickets
  getTicket: (id: string) => s.SupportTicketRow | undefined;
  createTicket: (t: {
    id: string;
    customerId: string;
    orderId: string | null;
    subject: string;
    description: string;
    priority: string;
    status: string;
    createdAt: number;
    updatedAt: number;
  }) => s.SupportTicketRow;
  updateTicket: (
    id: string,
    patch: Partial<Pick<s.SupportTicketRow, "status" | "priority" | "updatedAt">>,
  ) => void;
  getTicketsByCustomer: (customerId: string) => s.SupportTicketRow[];
  listTickets: (f: { status?: string; customerId?: string; limit?: number }) => s.SupportTicketRow[];

  // refunds
  createRefund: (r: {
    id: string;
    orderId: string;
    customerId: string;
    amount: number;
    reason: string;
    status: string;
    approvalId: string | null;
    idempotencyKey: string | null;
    createdAt: number;
    processedAt: number | null;
  }) => s.RefundRow;
  getRefund: (id: string) => s.RefundRow | undefined;
  getRefundByIdempotencyKey: (
    key: string,
  ) => s.RefundRow | undefined;
  getRefundsByOrder: (orderId: string) => s.RefundRow[];
  getRefundsByCustomer: (customerId: string) => s.RefundRow[];
  getRefundByApprovalId: (approvalId: string) => s.RefundRow | undefined;
  getOpenRefundForOrder: (
    orderId: string,
  ) => s.RefundRow | undefined;
  updateRefund: (
    id: string,
    patch: Partial<
      Pick<
        s.RefundRow,
        "status" | "processedAt" | "approvalId" | "idempotencyKey"
      >
    >,
  ) => void;

  // approvals
  createApproval: (a: {
    id: string;
    requestedBy: string;
    actorRole: s.Role;
    actionType: string;
    toolName: string;
    arguments: string;
    riskLevel: string;
    status: string;
    orderId: string | null;
    amountCents: number | null;
    idempotencyKey: string | null;
    createdAt: number;
  }) => s.ApprovalRequestRow;
  getApproval: (id: string) => s.ApprovalRequestRow | undefined;
  getPendingApprovalByIdempotencyKey: (
    key: string,
  ) => s.ApprovalRequestRow | undefined;
  updateApproval: (
    id: string,
    patch: Partial<
      Pick<
        s.ApprovalRequestRow,
        | "status"
        | "approvedBy"
        | "rejectionReason"
        | "resolvedAt"
      >
    >,
  ) => void;
  listApprovals: (filter?: {
    status?: string;
    role?: s.Role;
    limit?: number;
  }) => s.ApprovalRequestRow[];

  // audit
  addAudit: (e: {
    actorId: string;
    actorRole: s.Role;
    action: string;
    toolName?: string | null;
    arguments?: unknown;
    result?: unknown;
    approvalId?: string | null;
    conversationId?: string | null;
    timestamp?: number;
  }) => s.AuditLogRow;
  listAudit: (filter?: {
    actorId?: string;
    toolName?: string;
    limit?: number;
  }) => s.AuditLogRow[];

  // sessions
  createSession: (t: {
    token: string;
    customerId: string;
    createdAt: number;
    expiresAt: number;
  }) => void;
  getSession: (token: string) => s.SessionRow | undefined;
  revokeSession: (token: string) => void;

  // conversations / messages
  getOrCreateConversation: (
    customerId: string,
  ) => s.ConversationRow;
  listConversations: (customerId: string) => s.ConversationRow[];
  addMessage: (m: {
    conversationId: string;
    role: string;
    content: string;
    meta?: unknown;
    createdAt: number;
  }) => s.MessageRow;
  listMessages: (conversationId: string) => s.MessageRow[];

  // maintenance
  countAll: () => Record<string, number>;
  reset: () => void;
  transaction: <T>(fn: () => T) => T;
  principalOf: (id: string) => Principal | undefined;
}

export function createRepo(db: AppDatabase): Repo {
  const principalOf = (id: string): Principal | undefined => {
    const row = db
      .select({
        id: s.customers.id,
        name: s.customers.name,
        email: s.customers.email,
        role: s.customers.role,
      })
      .from(s.customers)
      .where(eq(s.customers.id, id))
      .get();
    if (!row) return undefined;
    return { id: row.id, name: row.name, email: row.email, role: row.role as Principal["role"] };
  };

  return {
    getCustomer: (id) =>
      db.select().from(s.customers).where(eq(s.customers.id, id)).get(),
    getCustomerByEmail: (email) =>
      db
        .select()
        .from(s.customers)
        .where(eq(s.customers.email, email.toLowerCase()))
        .get(),
    createCustomer: (c) => {
      db.insert(s.customers)
        .values({
          id: c.id,
          name: c.name,
          email: c.email,
          passwordHash: c.passwordHash,
          role: c.role,
          createdAt: c.createdAt,
        })
        .run();
    },
    listStaff: () =>
      db
        .select()
        .from(s.customers)
        .where(or(eq(s.customers.role, "support_agent"), eq(s.customers.role, "admin")))
        .all(),
    searchCustomers: (query, limit = 10) => {
      const q = `%${query.toLowerCase()}%`;
      const rows = db
        .select()
        .from(s.customers)
        .where(
          or(like(s.customers.name, q), like(s.customers.email, q), like(s.customers.id, q)),
        )
        .orderBy(asc(s.customers.name))
        .limit(limit)
        .all();
      return rows.filter((r) => r.role === "customer");
    },

    getOrder: (id) => {
      const row = db.select().from(s.orders).where(eq(s.orders.id, id)).get();
      return row ? mapOrder(row) : undefined;
    },
    getOrderRow: (id) =>
      db.select().from(s.orders).where(eq(s.orders.id, id)).get(),
    getOrdersByCustomer: (customerId) =>
      db
        .select()
        .from(s.orders)
        .where(eq(s.orders.customerId, customerId))
        .orderBy(asc(s.orders.createdAt))
        .all()
        .map(mapOrder),
    searchOrders: (f) => {
      const limit = f.limit ?? 10;
      const conds: any[] = [];
      if (f.customerId) conds.push(eq(s.orders.customerId, f.customerId));
      if (f.status) conds.push(eq(s.orders.status, f.status));
      const base = db.select().from(s.orders);
      const filtered = conds.length ? base.where(and(...conds)) : base;
      return filtered
        .orderBy(asc(s.orders.createdAt))
        .limit(limit)
        .all()
        .map(mapOrder);
    },
    getLatestOrder: (customerId) => {
      const rows = db
        .select()
        .from(s.orders)
        .where(eq(s.orders.customerId, customerId))
        .orderBy(asc(s.orders.createdAt))
        .all();
      return rows.length ? mapOrder(rows[rows.length - 1]) : undefined;
    },
    updateOrderRefundState: (id, refundableAmount, status) => {
      db.update(s.orders)
        .set({ refundableAmount, status })
        .where(eq(s.orders.id, id))
        .run();
    },

    getTicket: (id) =>
      db.select().from(s.supportTickets).where(eq(s.supportTickets.id, id)).get(),
    createTicket: (t) => {
      db.insert(s.supportTickets)
        .values({
          id: t.id,
          customerId: t.customerId,
          orderId: t.orderId,
          subject: t.subject,
          description: t.description,
          priority: t.priority,
          status: t.status,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })
        .run();
      return t as unknown as s.SupportTicketRow;
    },
    updateTicket: (id, patch) => {
      db.update(s.supportTickets).set(patch).where(eq(s.supportTickets.id, id)).run();
    },
    getTicketsByCustomer: (customerId) =>
      db
        .select()
        .from(s.supportTickets)
        .where(eq(s.supportTickets.customerId, customerId))
        .all(),
    listTickets: (f) => {
      const limit = f.limit ?? 15;
      const conds: any[] = [];
      if (f.customerId) conds.push(eq(s.supportTickets.customerId, f.customerId));
      if (f.status) conds.push(eq(s.supportTickets.status, f.status));
      const base = db.select().from(s.supportTickets);
      const filtered = conds.length ? base.where(and(...conds)) : base;
      return filtered.orderBy(desc(s.supportTickets.updatedAt)).limit(limit).all();
    },

    createRefund: (r) => {
      db.insert(s.refunds)
        .values({
          id: r.id,
          orderId: r.orderId,
          customerId: r.customerId,
          amount: r.amount,
          reason: r.reason,
          status: r.status,
          approvalId: r.approvalId,
          idempotencyKey: r.idempotencyKey,
          createdAt: r.createdAt,
          processedAt: r.processedAt,
        })
        .run();
      return r as unknown as s.RefundRow;
    },
    getRefund: (id) =>
      db.select().from(s.refunds).where(eq(s.refunds.id, id)).get(),
    getRefundByIdempotencyKey: (key) =>
      db
        .select()
        .from(s.refunds)
        .where(eq(s.refunds.idempotencyKey, key))
        .get(),
    getRefundsByOrder: (orderId) =>
      db
        .select()
        .from(s.refunds)
        .where(eq(s.refunds.orderId, orderId))
        .all(),
    getRefundsByCustomer: (customerId: string) =>
      db
        .select()
        .from(s.refunds)
        .where(eq(s.refunds.customerId, customerId))
        .all(),
    getRefundByApprovalId: (approvalId: string) =>
      db
        .select()
        .from(s.refunds)
        .where(eq(s.refunds.approvalId, approvalId))
        .get(),
    getOpenRefundForOrder: (orderId) =>
      db
        .select()
        .from(s.refunds)
        .where(
          and(
            eq(s.refunds.orderId, orderId),
            or(
              eq(s.refunds.status, "requested"),
              eq(s.refunds.status, "pending_approval"),
              eq(s.refunds.status, "approved"),
              eq(s.refunds.status, "processing"),
            ),
          ),
        )
        .get(),
    updateRefund: (id, patch) => {
      db.update(s.refunds).set(patch).where(eq(s.refunds.id, id)).run();
    },

    createApproval: (a) => {
      db.insert(s.approvalRequests)
        .values({
          id: a.id,
          requestedBy: a.requestedBy,
          actorRole: a.actorRole,
          actionType: a.actionType,
          toolName: a.toolName,
          arguments: a.arguments,
          riskLevel: a.riskLevel,
          status: a.status,
          orderId: a.orderId,
          amountCents: a.amountCents,
          idempotencyKey: a.idempotencyKey,
          createdAt: a.createdAt,
          resolvedAt: null,
          approvedBy: null,
          rejectionReason: null,
        })
        .run();
      return a as unknown as s.ApprovalRequestRow;
    },
    getApproval: (id) =>
      db
        .select()
        .from(s.approvalRequests)
        .where(eq(s.approvalRequests.id, id))
        .get(),
    getPendingApprovalByIdempotencyKey: (key) =>
      db
        .select()
        .from(s.approvalRequests)
        .where(
          and(
            eq(s.approvalRequests.idempotencyKey, key),
            eq(s.approvalRequests.status, "pending_approval"),
          ),
        )
        .get(),
    updateApproval: (id, patch) => {
      db.update(s.approvalRequests)
        .set(patch)
        .where(eq(s.approvalRequests.id, id))
        .run();
    },
    listApprovals: (filter) => {
      const limit = filter?.limit ?? 200;
      const base = db.select().from(s.approvalRequests);
      const filtered = filter?.status
        ? base.where(eq(s.approvalRequests.status, filter.status))
        : base;
      return filtered.orderBy(asc(s.approvalRequests.createdAt)).limit(limit).all();
    },

    addAudit: (e) => {
      db.insert(s.auditLogs)
        .values({
          actorId: e.actorId,
          actorRole: e.actorRole,
          action: e.action,
          toolName: e.toolName ?? null,
          arguments: e.arguments === undefined ? null : JSON.stringify(e.arguments),
          result: e.result === undefined ? null : JSON.stringify(e.result),
          approvalId: e.approvalId ?? null,
          conversationId: e.conversationId ?? null,
          timestamp: e.timestamp ?? Date.now(),
        })
        .run();
      const last = db
        .select()
        .from(s.auditLogs)
        .orderBy(asc(s.auditLogs.id))
        .limit(1)
        .all()
        .pop();
      return last as unknown as s.AuditLogRow;
    },
    listAudit: (filter) => {
      const limit = filter?.limit ?? 200;
      const base = db.select().from(s.auditLogs);
      const conds: any[] = [];
      if (filter?.actorId) conds.push(eq(s.auditLogs.actorId, filter.actorId));
      if (filter?.toolName) conds.push(like(s.auditLogs.toolName, `%${filter.toolName}%`));
      const filtered = conds.length ? base.where(or(...conds)) : base;
      const all = filtered.orderBy(asc(s.auditLogs.timestamp)).limit(limit * 2).all();
      return all.slice(-limit);
    },

    createSession: (t) => {
      db.insert(s.sessions)
        .values({
          token: t.token,
          customerId: t.customerId,
          createdAt: t.createdAt,
          expiresAt: t.expiresAt,
        })
        .run();
    },
    getSession: (token) =>
      db.select().from(s.sessions).where(eq(s.sessions.token, token)).get(),
    revokeSession: (token) => {
      db.delete(s.sessions).where(eq(s.sessions.token, token)).run();
    },

    getOrCreateConversation: (customerId) => {
      const existing = db
        .select()
        .from(s.conversations)
        .where(eq(s.conversations.customerId, customerId))
        .orderBy(asc(s.conversations.createdAt))
        .limit(1)
        .get();
      if (existing) return existing;
      const id = `CONV-${customerId}`;
      db.insert(s.conversations)
        .values({
          id,
          customerId,
          title: "Support conversation",
          createdAt: Date.now(),
        })
        .run();
      return db.select().from(s.conversations).where(eq(s.conversations.id, id)).get()!;
    },
    listConversations: (customerId) =>
      db
        .select()
        .from(s.conversations)
        .where(eq(s.conversations.customerId, customerId))
        .all(),
    addMessage: (m) => {
      db.insert(s.messages)
        .values({
          conversationId: m.conversationId,
          role: m.role,
          content: m.content,
          meta: m.meta === undefined ? null : JSON.stringify(m.meta),
          createdAt: m.createdAt,
        })
        .run();
      const row = db
        .select()
        .from(s.messages)
        .orderBy(asc(s.messages.id))
        .all()
        .pop();
      return row as s.MessageRow;
    },
    listMessages: (conversationId) =>
      db
        .select()
        .from(s.messages)
        .where(eq(s.messages.conversationId, conversationId))
        .orderBy(asc(s.messages.id))
        .all(),

    countAll: () => ({
      customers: db.select().from(s.customers).all().length,
      orders: db.select().from(s.orders).all().length,
      tickets: db.select().from(s.supportTickets).all().length,
      refunds: db.select().from(s.refunds).all().length,
      approvals: db.select().from(s.approvalRequests).all().length,
      audit: db.select().from(s.auditLogs).all().length,
    }),
    reset: () => {
      db.transaction((tx: any) => {
        tx.delete(s.messages).run();
        tx.delete(s.conversations).run();
        tx.delete(s.sessions).run();
        tx.delete(s.auditLogs).run();
        tx.delete(s.approvalRequests).run();
        tx.delete(s.refunds).run();
        tx.delete(s.supportTickets).run();
        tx.delete(s.orders).run();
        tx.delete(s.customers).run();
      });
    },
    transaction: <T>(fn: () => T): T => db.transaction(fn),
    principalOf,
  };
}
