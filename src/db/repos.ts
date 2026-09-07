import { and, asc, desc, eq, like, or } from "drizzle-orm";
import * as s from "./schema";
import * as pg from "./schema.pg";
import type {
  ApprovalRequestRow,
  AuditLogRow,
  ConversationRow,
  CustomerRow,
  MessageRow,
  OrderRow,
  RefundRow,
  SessionRow,
  SupportTicketRow,
} from "./row-types";
import { dbMode } from "@/lib/env";
import { getPostgresDb, getDb, type AppDatabase, type PgDatabase } from "./client";
import { genId } from "@/lib/ids";
import { parseJson } from "@/lib/util";
import type { Order, OrderItem, Principal, ShippingAddress } from "@/lib/types";

/**
 * Driver-agnostic data access. The whole app depends only on the async `Repo`
 * interface; `createSqliteRepo` (local, default) and `createPostgresRepo`
 * (Supabase, when DATABASE_URL is set) implement it identically.
 */

function mapOrder(row: OrderRow): Order {
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
  getCustomer: (id: string) => Promise<CustomerRow | undefined>;
  getCustomerByEmail: (email: string) => Promise<CustomerRow | undefined>;
  createCustomer: (c: { id: string; name: string; email: string; passwordHash: string; role: string; createdAt: number }) => Promise<void>;
  listStaff: () => Promise<CustomerRow[]>;
  searchCustomers: (query: string, limit?: number) => Promise<CustomerRow[]>;

  // orders
  getOrder: (id: string) => Promise<Order | undefined>;
  getOrderRow: (id: string) => Promise<OrderRow | undefined>;
  createOrder: (o: {
    id: string; customerId: string; status: string; total: number; currency: string;
    items: string; shippingAddress: string; trackingNumber: string | null;
    createdAt: number; deliveredAt: number | null; refundableAmount: number;
  }) => Promise<void>;
  getOrdersByCustomer: (customerId: string) => Promise<Order[]>;
  searchOrders: (f: { customerId?: string; status?: string; limit?: number }) => Promise<Order[]>;
  getLatestOrder: (customerId: string) => Promise<Order | undefined>;
  updateOrderRefundState: (id: string, refundableAmount: number, status: string) => Promise<void>;

  // tickets
  getTicket: (id: string) => Promise<SupportTicketRow | undefined>;
  createTicket: (t: {
    id: string; customerId: string; orderId: string | null; subject: string;
    description: string; priority: string; status: string; internalNotes: string | null;
    createdAt: number; updatedAt: number;
  }) => Promise<SupportTicketRow>;
  updateTicket: (id: string, patch: Partial<Pick<SupportTicketRow, "status" | "priority" | "internalNotes" | "updatedAt">>) => Promise<void>;
  getTicketsByCustomer: (customerId: string) => Promise<SupportTicketRow[]>;
  listTickets: (f: { status?: string; customerId?: string; limit?: number }) => Promise<SupportTicketRow[]>;

  // refunds
  createRefund: (r: {
    id: string; orderId: string; customerId: string; amount: number; reason: string; status: string;
    approvalId: string | null; idempotencyKey: string | null; createdAt: number; processedAt: number | null;
  }) => Promise<RefundRow>;
  getRefund: (id: string) => Promise<RefundRow | undefined>;
  getRefundByIdempotencyKey: (key: string) => Promise<RefundRow | undefined>;
  getRefundsByOrder: (orderId: string) => Promise<RefundRow[]>;
  getRefundsByCustomer: (customerId: string) => Promise<RefundRow[]>;
  getRefundByApprovalId: (approvalId: string) => Promise<RefundRow | undefined>;
  getOpenRefundForOrder: (orderId: string) => Promise<RefundRow | undefined>;
  updateRefund: (id: string, patch: Partial<Pick<RefundRow, "status" | "processedAt" | "approvalId" | "idempotencyKey">>) => Promise<void>;

  // approvals
  createApproval: (a: {
    id: string; requestedBy: string; actorRole: string; actionType: string; toolName: string; arguments: string;
    riskLevel: string; status: string; orderId: string | null; amountCents: number | null;
    idempotencyKey: string | null; createdAt: number;
  }) => Promise<ApprovalRequestRow>;
  getApproval: (id: string) => Promise<ApprovalRequestRow | undefined>;
  getPendingApprovalByIdempotencyKey: (key: string) => Promise<ApprovalRequestRow | undefined>;
  updateApproval: (id: string, patch: Partial<Pick<ApprovalRequestRow, "status" | "approvedBy" | "rejectionReason" | "resolvedAt">>) => Promise<void>;
  listApprovals: (filter?: { status?: string; role?: string; limit?: number }) => Promise<ApprovalRequestRow[]>;

  // audit
  addAudit: (e: {
    actorId: string; actorRole: string; action: string; toolName?: string | null; arguments?: unknown;
    result?: unknown; approvalId?: string | null; conversationId?: string | null; timestamp?: number;
  }) => Promise<AuditLogRow>;
  listAudit: (filter?: { actorId?: string; toolName?: string; limit?: number }) => Promise<AuditLogRow[]>;

  // sessions
  createSession: (t: { token: string; customerId: string; createdAt: number; expiresAt: number }) => Promise<void>;
  getSession: (token: string) => Promise<SessionRow | undefined>;
  revokeSession: (token: string) => Promise<void>;

  // conversations / messages
  getOrCreateConversation: (customerId: string) => Promise<ConversationRow>;
  listConversations: (customerId: string) => Promise<ConversationRow[]>;
  addMessage: (m: { conversationId: string; role: string; content: string; meta?: unknown; createdAt: number }) => Promise<MessageRow>;
  listMessages: (conversationId: string) => Promise<MessageRow[]>;

  // maintenance
  countAll: () => Promise<Record<string, number>>;
  reset: () => Promise<void>;
  transaction: <T>(fn: (repo: Repo) => Promise<T>) => Promise<T>;
  /**
   * Atomically complete a pending refund + decrement the order balance. Each
   * driver implements this with its own transaction semantics (better-sqlite3
   * transactions must be SYNC; Postgres transactions are async).
   */
  applyRefund: (opts: { orderId: string; amount: number }) => Promise<RefundRow>;
  principalOf: (id: string) => Promise<Principal | undefined>;
}

/* -------------------------------------------------------------------------- */
/*  SQLite adapter (local, default; used by tests)                            */
/* -------------------------------------------------------------------------- */

export function createSqliteRepo(db: AppDatabase): Repo {
  return {
    getCustomer: async (id) => await db.select().from(s.customers).where(eq(s.customers.id, id)).get(),
    getCustomerByEmail: async (email) =>
      await db.select().from(s.customers).where(eq(s.customers.email, email.toLowerCase())).get(),
    createCustomer: async (c) => {
      await db.insert(s.customers)
        .values({ id: c.id, name: c.name, email: c.email, passwordHash: c.passwordHash, role: c.role, createdAt: c.createdAt })
        .run();
    },
    listStaff: async () =>
      await db.select().from(s.customers).where(or(eq(s.customers.role, "support_agent"), eq(s.customers.role, "admin"))).all(),
    searchCustomers: async (query, limit = 10) => {
      const q = `%${query.toLowerCase()}%`;
      const rows = await db
        .select().from(s.customers)
        .where(or(like(s.customers.name, q), like(s.customers.email, q), like(s.customers.id, q)))
        .orderBy(asc(s.customers.name)).limit(limit).all();
      return rows.filter((r) => r.role === "customer");
    },

    getOrder: async (id) => {
      const row = await db.select().from(s.orders).where(eq(s.orders.id, id)).get();
      return row ? mapOrder(row) : undefined;
    },
    getOrderRow: async (id) => await db.select().from(s.orders).where(eq(s.orders.id, id)).get(),
    createOrder: async (o) => {
      await db.insert(s.orders).values({
        id: o.id, customerId: o.customerId, status: o.status, total: o.total, currency: o.currency,
        items: o.items, shippingAddress: o.shippingAddress, trackingNumber: o.trackingNumber,
        createdAt: o.createdAt, deliveredAt: o.deliveredAt, refundableAmount: o.refundableAmount,
      }).run();
    },
    getOrdersByCustomer: async (customerId) =>
      (await db.select().from(s.orders).where(eq(s.orders.customerId, customerId)).orderBy(asc(s.orders.createdAt)).all()).map(mapOrder),
    searchOrders: async (f) => {
      const limit = f.limit ?? 10;
      const conds: any[] = [];
      if (f.customerId) conds.push(eq(s.orders.customerId, f.customerId));
      if (f.status) conds.push(eq(s.orders.status, f.status));
      const base = db.select().from(s.orders);
      const filtered = conds.length ? base.where(and(...conds)) : base;
      return (await filtered.orderBy(asc(s.orders.createdAt)).limit(limit).all()).map(mapOrder);
    },
    getLatestOrder: async (customerId) => {
      const rows = await db.select().from(s.orders).where(eq(s.orders.customerId, customerId)).orderBy(asc(s.orders.createdAt)).all();
      return rows.length ? mapOrder(rows[rows.length - 1]) : undefined;
    },
    updateOrderRefundState: async (id, refundableAmount, status) => {
      await db.update(s.orders).set({ refundableAmount, status }).where(eq(s.orders.id, id)).run();
    },

    getTicket: async (id) => await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, id)).get(),
    createTicket: async (t) => {
      const row = await db.insert(s.supportTickets).values({
        id: t.id, customerId: t.customerId, orderId: t.orderId, subject: t.subject, description: t.description,
        priority: t.priority, status: t.status, internalNotes: t.internalNotes,
        createdAt: t.createdAt, updatedAt: t.updatedAt,
      }).returning().get();
      return row as SupportTicketRow;
    },
    updateTicket: async (id, patch) => {
      await db.update(s.supportTickets).set(patch).where(eq(s.supportTickets.id, id)).run();
    },
    getTicketsByCustomer: async (customerId) =>
      await db.select().from(s.supportTickets).where(eq(s.supportTickets.customerId, customerId)).all(),
    listTickets: async (f) => {
      const limit = f.limit ?? 15;
      const conds: any[] = [];
      if (f.customerId) conds.push(eq(s.supportTickets.customerId, f.customerId));
      if (f.status) conds.push(eq(s.supportTickets.status, f.status));
      const base = db.select().from(s.supportTickets);
      const filtered = conds.length ? base.where(and(...conds)) : base;
      return await filtered.orderBy(desc(s.supportTickets.updatedAt)).limit(limit).all();
    },

    createRefund: async (r) => {
      const row = await db.insert(s.refunds).values({
        id: r.id, orderId: r.orderId, customerId: r.customerId, amount: r.amount, reason: r.reason, status: r.status,
        approvalId: r.approvalId, idempotencyKey: r.idempotencyKey, createdAt: r.createdAt, processedAt: r.processedAt,
      }).returning().get();
      return row as RefundRow;
    },
    getRefund: async (id) => await db.select().from(s.refunds).where(eq(s.refunds.id, id)).get(),
    getRefundByIdempotencyKey: async (key) =>
      await db.select().from(s.refunds).where(eq(s.refunds.idempotencyKey, key)).get(),
    getRefundsByOrder: async (orderId) => await db.select().from(s.refunds).where(eq(s.refunds.orderId, orderId)).all(),
    getRefundsByCustomer: async (customerId) => await db.select().from(s.refunds).where(eq(s.refunds.customerId, customerId)).all(),
    getRefundByApprovalId: async (approvalId) => await db.select().from(s.refunds).where(eq(s.refunds.approvalId, approvalId)).get(),
    getOpenRefundForOrder: async (orderId) =>
      await db.select().from(s.refunds).where(
        and(
          eq(s.refunds.orderId, orderId),
          or(eq(s.refunds.status, "requested"), eq(s.refunds.status, "pending_approval"), eq(s.refunds.status, "approved"), eq(s.refunds.status, "processing")),
        ),
      ).get(),
    updateRefund: async (id, patch) => {
      await db.update(s.refunds).set(patch).where(eq(s.refunds.id, id)).run();
    },

    createApproval: async (a) => {
      const row = await db.insert(s.approvalRequests).values({
        id: a.id, requestedBy: a.requestedBy, actorRole: a.actorRole, actionType: a.actionType, toolName: a.toolName,
        arguments: a.arguments, riskLevel: a.riskLevel, status: a.status, orderId: a.orderId, amountCents: a.amountCents,
        idempotencyKey: a.idempotencyKey, createdAt: a.createdAt, resolvedAt: null, approvedBy: null, rejectionReason: null,
      }).returning().get();
      return row as ApprovalRequestRow;
    },
    getApproval: async (id) => await db.select().from(s.approvalRequests).where(eq(s.approvalRequests.id, id)).get(),
    getPendingApprovalByIdempotencyKey: async (key) =>
      await db.select().from(s.approvalRequests).where(and(eq(s.approvalRequests.idempotencyKey, key), eq(s.approvalRequests.status, "pending_approval"))).get(),
    updateApproval: async (id, patch) => {
      await db.update(s.approvalRequests).set(patch).where(eq(s.approvalRequests.id, id)).run();
    },
    listApprovals: async (filter) => {
      const limit = filter?.limit ?? 200;
      const base = db.select().from(s.approvalRequests);
      const filtered = filter?.status ? base.where(eq(s.approvalRequests.status, filter.status)) : base;
      return await filtered.orderBy(asc(s.approvalRequests.createdAt)).limit(limit).all();
    },

    addAudit: async (e) => {
      const row = await db.insert(s.auditLogs).values({
        actorId: e.actorId, actorRole: e.actorRole, action: e.action, toolName: e.toolName ?? null,
        arguments: e.arguments === undefined ? null : JSON.stringify(e.arguments),
        result: e.result === undefined ? null : JSON.stringify(e.result),
        approvalId: e.approvalId ?? null, conversationId: e.conversationId ?? null, timestamp: e.timestamp ?? Date.now(),
      }).returning().get();
      return row as AuditLogRow;
    },
    listAudit: async (filter) => {
      const limit = filter?.limit ?? 200;
      const base = db.select().from(s.auditLogs);
      const conds: any[] = [];
      if (filter?.actorId) conds.push(eq(s.auditLogs.actorId, filter.actorId));
      if (filter?.toolName) conds.push(like(s.auditLogs.toolName, `%${filter.toolName}%`));
      const filtered = conds.length ? base.where(or(...conds)) : base;
      const all = await filtered.orderBy(asc(s.auditLogs.timestamp)).limit(limit * 2).all();
      return all.slice(-limit);
    },

    createSession: async (t) => {
      await db.insert(s.sessions).values({ token: t.token, customerId: t.customerId, createdAt: t.createdAt, expiresAt: t.expiresAt }).run();
    },
    getSession: async (token) => await db.select().from(s.sessions).where(eq(s.sessions.token, token)).get(),
    revokeSession: async (token) => {
      await db.delete(s.sessions).where(eq(s.sessions.token, token)).run();
    },

    getOrCreateConversation: async (customerId) => {
      const existing = await db.select().from(s.conversations).where(eq(s.conversations.customerId, customerId)).orderBy(asc(s.conversations.createdAt)).limit(1).get();
      if (existing) return existing;
      const id = `CONV-${customerId}`;
      await db.insert(s.conversations).values({ id, customerId, title: "Support conversation", createdAt: Date.now() }).run();
      return (await db.select().from(s.conversations).where(eq(s.conversations.id, id)).get())!;
    },
    listConversations: async (customerId) =>
      await db.select().from(s.conversations).where(eq(s.conversations.customerId, customerId)).all(),
    addMessage: async (m) => {
      const row = await db.insert(s.messages).values({
        conversationId: m.conversationId, role: m.role, content: m.content,
        meta: m.meta === undefined ? null : JSON.stringify(m.meta), createdAt: m.createdAt,
      }).returning().get();
      return row as MessageRow;
    },
    listMessages: async (conversationId) =>
      await db.select().from(s.messages).where(eq(s.messages.conversationId, conversationId)).orderBy(asc(s.messages.id)).all(),

    countAll: async () => ({
      customers: (await db.select().from(s.customers).all()).length,
      orders: (await db.select().from(s.orders).all()).length,
      tickets: (await db.select().from(s.supportTickets).all()).length,
      refunds: (await db.select().from(s.refunds).all()).length,
      approvals: (await db.select().from(s.approvalRequests).all()).length,
      audit: (await db.select().from(s.auditLogs).all()).length,
    }),
    reset: async () => {
      // better-sqlite3 is synchronous: run plain DELETEs (FK-safe order) on the
      // raw handle. A drizzle transaction callback here MUST be sync too.
      const raw = (db as unknown as { $client: any }).$client;
      raw.exec("BEGIN");
      try {
        raw.exec("DELETE FROM messages");
        raw.exec("DELETE FROM conversations");
        raw.exec("DELETE FROM sessions");
        raw.exec("DELETE FROM audit_logs");
        raw.exec("DELETE FROM approval_requests");
        raw.exec("DELETE FROM refunds");
        raw.exec("DELETE FROM support_tickets");
        raw.exec("DELETE FROM orders");
        raw.exec("DELETE FROM customers");
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    transaction: async <T>(fn: (repo: Repo) => Promise<T>): Promise<T> => {
      // Run fn against a repo bound to the live transaction handle.
      return db.transaction(async (t: any) => {
        const txRepo: Repo = createSqliteRepo(t as AppDatabase);
        return fn(txRepo);
      });
    },
    applyRefund: async (opts) => {
      const order = await db.select().from(s.orders).where(eq(s.orders.id, opts.orderId)).get();
      if (!order) throw new Error("Order not found during refund");
      // better-sqlite3 transactions must be SYNCHRONOUS (driver rejects a promise).
      // better-sqlite3: db.transaction(fn) EXECUTES synchronously and returns fn's result.
      const refundId = db.transaction((tx: any) => {
        const existing = tx
          .select()
          .from(s.refunds)
          .where(
            and(
              eq(s.refunds.orderId, order.id),
              or(
                eq(s.refunds.status, "requested"),
                eq(s.refunds.status, "pending_approval"),
                eq(s.refunds.status, "approved"),
                eq(s.refunds.status, "processing"),
              ),
            ),
          )
          .get() as RefundRow | undefined;
        const remaining = order.refundableAmount - opts.amount;
        const status = remaining <= 0 ? "refunded" : "partially_refunded";
        let id: string;
        if (existing) {
          id = existing.id;
          tx.update(s.refunds).set({ status: "completed", processedAt: Date.now() }).where(eq(s.refunds.id, existing.id)).run();
        } else {
          id = genId("REF");
          tx.insert(s.refunds)
            .values({
              id, orderId: order.id, customerId: order.customerId, amount: opts.amount, reason: "Approved refund",
              status: "completed", approvalId: null, idempotencyKey: null, createdAt: Date.now(), processedAt: Date.now(),
            })
            .run();
        }
        tx.update(s.orders).set({ refundableAmount: Math.max(0, remaining), status }).where(eq(s.orders.id, order.id)).run();
        return id;
      });
      const row = await db.select().from(s.refunds).where(eq(s.refunds.id, refundId)).get();
      return row as RefundRow;
    },
    principalOf: async (id) => {
      const row = await db.select().from(s.customers).where(eq(s.customers.id, id)).get();
      if (!row) return undefined;
      return { id: row.id, name: row.name, email: row.email, role: row.role as Principal["role"] };
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Postgres / Supabase adapter (used when DATABASE_URL is set)               */
/* -------------------------------------------------------------------------- */

// Postgres select helpers: drizzle pg queries are awaited and return arrays.
// Return `any` so callers infer the concrete row type at the use site.
async function pgOne(q: any): Promise<any> {
  const rows = await q;
  return rows?.[0];
}
async function pgAll(q: any): Promise<any> {
  return await q;
}

export function createPostgresRepo(db: PgDatabase): Repo {
  return {
    getCustomer: async (id) => await pgOne(db.select().from(pg.customers).where(eq(pg.customers.id, id))),
    getCustomerByEmail: async (email) =>
      await pgOne(db.select().from(pg.customers).where(eq(pg.customers.email, email.toLowerCase()))),
    createCustomer: async (c) => {
      await db.insert(pg.customers).values({ id: c.id, name: c.name, email: c.email, passwordHash: c.passwordHash, role: c.role, createdAt: c.createdAt });
    },
    listStaff: async () =>
      await pgAll(db.select().from(pg.customers).where(or(eq(pg.customers.role, "support_agent"), eq(pg.customers.role, "admin")))),
    searchCustomers: async (query, limit = 10) => {
      const q = `%${query.toLowerCase()}%`;
      const rows = await pgAll(
        db.select().from(pg.customers)
          .where(or(like(pg.customers.name, q), like(pg.customers.email, q), like(pg.customers.id, q)))
          .orderBy(asc(pg.customers.name)).limit(limit),
      );
      return rows.filter((r: CustomerRow) => r.role === "customer");
    },

    getOrder: async (id) => {
      const row = await pgOne(db.select().from(pg.orders).where(eq(pg.orders.id, id)));
      return row ? mapOrder(row) : undefined;
    },
    getOrderRow: async (id) => await pgOne(db.select().from(pg.orders).where(eq(pg.orders.id, id))),
    createOrder: async (o) => {
      await db.insert(pg.orders).values({
        id: o.id, customerId: o.customerId, status: o.status, total: o.total, currency: o.currency,
        items: o.items, shippingAddress: o.shippingAddress, trackingNumber: o.trackingNumber,
        createdAt: o.createdAt, deliveredAt: o.deliveredAt, refundableAmount: o.refundableAmount,
      });
    },
    getOrdersByCustomer: async (customerId) =>
      (await pgAll(db.select().from(pg.orders).where(eq(pg.orders.customerId, customerId)).orderBy(asc(pg.orders.createdAt)))).map(mapOrder),
    searchOrders: async (f) => {
      const limit = f.limit ?? 10;
      const conds: any[] = [];
      if (f.customerId) conds.push(eq(pg.orders.customerId, f.customerId));
      if (f.status) conds.push(eq(pg.orders.status, f.status));
      const base = db.select().from(pg.orders);
      const filtered = conds.length ? base.where(and(...conds)) : base;
      return (await pgAll(filtered.orderBy(asc(pg.orders.createdAt)).limit(limit))).map(mapOrder);
    },
    getLatestOrder: async (customerId) => {
      const rows = await pgAll(db.select().from(pg.orders).where(eq(pg.orders.customerId, customerId)).orderBy(asc(pg.orders.createdAt)));
      return rows.length ? mapOrder(rows[rows.length - 1]) : undefined;
    },
    updateOrderRefundState: async (id, refundableAmount, status) => {
      await db.update(pg.orders).set({ refundableAmount, status }).where(eq(pg.orders.id, id));
    },

    getTicket: async (id) => await pgOne(db.select().from(pg.supportTickets).where(eq(pg.supportTickets.id, id))),
    createTicket: async (t) => {
      await db.insert(pg.supportTickets).values({
        id: t.id, customerId: t.customerId, orderId: t.orderId, subject: t.subject, description: t.description,
        priority: t.priority, status: t.status, internalNotes: t.internalNotes,
        createdAt: t.createdAt, updatedAt: t.updatedAt,
      });
      return (await pgOne(db.select().from(pg.supportTickets).where(eq(pg.supportTickets.id, t.id))))!;
    },
    updateTicket: async (id, patch) => {
      await db.update(pg.supportTickets).set(patch).where(eq(pg.supportTickets.id, id));
    },
    getTicketsByCustomer: async (customerId) =>
      await pgAll(db.select().from(pg.supportTickets).where(eq(pg.supportTickets.customerId, customerId))),
    listTickets: async (f) => {
      const limit = f.limit ?? 15;
      const conds: any[] = [];
      if (f.customerId) conds.push(eq(pg.supportTickets.customerId, f.customerId));
      if (f.status) conds.push(eq(pg.supportTickets.status, f.status));
      const base = db.select().from(pg.supportTickets);
      const filtered = conds.length ? base.where(and(...conds)) : base;
      return await pgAll(filtered.orderBy(desc(pg.supportTickets.updatedAt)).limit(limit));
    },

    createRefund: async (r) => {
      await db.insert(pg.refunds).values({
        id: r.id, orderId: r.orderId, customerId: r.customerId, amount: r.amount, reason: r.reason, status: r.status,
        approvalId: r.approvalId, idempotencyKey: r.idempotencyKey, createdAt: r.createdAt, processedAt: r.processedAt,
      });
      return (await pgOne(db.select().from(pg.refunds).where(eq(pg.refunds.id, r.id))))!;
    },
    getRefund: async (id) => await pgOne(db.select().from(pg.refunds).where(eq(pg.refunds.id, id))),
    getRefundByIdempotencyKey: async (key) => await pgOne(db.select().from(pg.refunds).where(eq(pg.refunds.idempotencyKey, key))),
    getRefundsByOrder: async (orderId) => await pgAll(db.select().from(pg.refunds).where(eq(pg.refunds.orderId, orderId))),
    getRefundsByCustomer: async (customerId) => await pgAll(db.select().from(pg.refunds).where(eq(pg.refunds.customerId, customerId))),
    getRefundByApprovalId: async (approvalId) => await pgOne(db.select().from(pg.refunds).where(eq(pg.refunds.approvalId, approvalId))),
    getOpenRefundForOrder: async (orderId) =>
      await pgOne(
        db.select().from(pg.refunds).where(
          and(
            eq(pg.refunds.orderId, orderId),
            or(eq(pg.refunds.status, "requested"), eq(pg.refunds.status, "pending_approval"), eq(pg.refunds.status, "approved"), eq(pg.refunds.status, "processing")),
          ),
        ),
      ),
    updateRefund: async (id, patch) => {
      await db.update(pg.refunds).set(patch).where(eq(pg.refunds.id, id));
    },

    createApproval: async (a) => {
      await db.insert(pg.approvalRequests).values({
        id: a.id, requestedBy: a.requestedBy, actorRole: a.actorRole, actionType: a.actionType, toolName: a.toolName,
        arguments: a.arguments, riskLevel: a.riskLevel, status: a.status, orderId: a.orderId, amountCents: a.amountCents,
        idempotencyKey: a.idempotencyKey, createdAt: a.createdAt, resolvedAt: null, approvedBy: null, rejectionReason: null,
      });
      return (await pgOne(db.select().from(pg.approvalRequests).where(eq(pg.approvalRequests.id, a.id))))!;
    },
    getApproval: async (id) => await pgOne(db.select().from(pg.approvalRequests).where(eq(pg.approvalRequests.id, id))),
    getPendingApprovalByIdempotencyKey: async (key) =>
      await pgOne(db.select().from(pg.approvalRequests).where(and(eq(pg.approvalRequests.idempotencyKey, key), eq(pg.approvalRequests.status, "pending_approval")))),
    updateApproval: async (id, patch) => {
      await db.update(pg.approvalRequests).set(patch).where(eq(pg.approvalRequests.id, id));
    },
    listApprovals: async (filter) => {
      const limit = filter?.limit ?? 200;
      const base = db.select().from(pg.approvalRequests);
      const filtered = filter?.status ? base.where(eq(pg.approvalRequests.status, filter.status)) : base;
      return await pgAll(filtered.orderBy(asc(pg.approvalRequests.createdAt)).limit(limit));
    },

    addAudit: async (e) => {
      await db.insert(pg.auditLogs).values({
        actorId: e.actorId, actorRole: e.actorRole, action: e.action, toolName: e.toolName ?? null,
        arguments: e.arguments === undefined ? null : JSON.stringify(e.arguments),
        result: e.result === undefined ? null : JSON.stringify(e.result),
        approvalId: e.approvalId ?? null, conversationId: e.conversationId ?? null, timestamp: e.timestamp ?? Date.now(),
      });
      // Return a best-effort row (id is a serial); not read back for correctness.
      return (await pgOne(db.select().from(pg.auditLogs).where(eq(pg.auditLogs.approvalId, e.approvalId ?? "")))) ?? ({} as AuditLogRow);
    },
    listAudit: async (filter) => {
      const limit = filter?.limit ?? 200;
      const base = db.select().from(pg.auditLogs);
      const conds: any[] = [];
      if (filter?.actorId) conds.push(eq(pg.auditLogs.actorId, filter.actorId));
      if (filter?.toolName) conds.push(like(pg.auditLogs.toolName, `%${filter.toolName}%`));
      const filtered = conds.length ? base.where(or(...conds)) : base;
      const all = await pgAll(filtered.orderBy(asc(pg.auditLogs.timestamp)).limit(limit * 2));
      return all.slice(-limit);
    },

    createSession: async (t) => {
      await db.insert(pg.sessions).values({ token: t.token, customerId: t.customerId, createdAt: t.createdAt, expiresAt: t.expiresAt });
    },
    getSession: async (token) => await pgOne(db.select().from(pg.sessions).where(eq(pg.sessions.token, token))),
    revokeSession: async (token) => {
      await db.delete(pg.sessions).where(eq(pg.sessions.token, token));
    },

    getOrCreateConversation: async (customerId) => {
      const existing = await pgOne(db.select().from(pg.conversations).where(eq(pg.conversations.customerId, customerId)).orderBy(asc(pg.conversations.createdAt)).limit(1));
      if (existing) return existing;
      const id = `CONV-${customerId}`;
      await db.insert(pg.conversations).values({ id, customerId, title: "Support conversation", createdAt: Date.now() });
      return (await pgOne(db.select().from(pg.conversations).where(eq(pg.conversations.id, id))))!;
    },
    listConversations: async (customerId) => await pgAll(db.select().from(pg.conversations).where(eq(pg.conversations.customerId, customerId))),
    addMessage: async (m) => {
      await db.insert(pg.messages).values({
        conversationId: m.conversationId, role: m.role, content: m.content,
        meta: m.meta === undefined ? null : JSON.stringify(m.meta), createdAt: m.createdAt,
      });
      // Latest message in the conversation.
      return (await pgAll(db.select().from(pg.messages).where(eq(pg.messages.conversationId, m.conversationId)).orderBy(desc(pg.messages.id)).limit(1)))[0];
    },
    listMessages: async (conversationId) =>
      await pgAll(db.select().from(pg.messages).where(eq(pg.messages.conversationId, conversationId)).orderBy(asc(pg.messages.id))),

    countAll: async () => ({
      customers: (await pgAll(db.select().from(pg.customers))).length,
      orders: (await pgAll(db.select().from(pg.orders))).length,
      tickets: (await pgAll(db.select().from(pg.supportTickets))).length,
      refunds: (await pgAll(db.select().from(pg.refunds))).length,
      approvals: (await pgAll(db.select().from(pg.approvalRequests))).length,
      audit: (await pgAll(db.select().from(pg.auditLogs))).length,
    }),
    reset: async () => {
      await db.transaction(async (tx: any) => {
        await tx.delete(pg.messages);
        await tx.delete(pg.conversations);
        await tx.delete(pg.sessions);
        await tx.delete(pg.auditLogs);
        await tx.delete(pg.approvalRequests);
        await tx.delete(pg.refunds);
        await tx.delete(pg.supportTickets);
        await tx.delete(pg.orders);
        await tx.delete(pg.customers);
      });
    },
    transaction: async <T>(fn: (repo: Repo) => Promise<T>): Promise<T> => {
      return db.transaction(async (t: any) => {
        const txRepo: Repo = createPostgresRepo(t as PgDatabase);
        return fn(txRepo);
      });
    },
    applyRefund: async (opts) => {
      const order = await pgOne(db.select().from(pg.orders).where(eq(pg.orders.id, opts.orderId)));
      if (!order) throw new Error("Order not found during refund");
      // Postgres transactions are async.
      const refundId = await db.transaction(async (tx: any) => {
        const existing = await pgOne(
          tx
            .select()
            .from(pg.refunds)
            .where(
              and(
                eq(pg.refunds.orderId, order.id),
                or(
                  eq(pg.refunds.status, "requested"),
                  eq(pg.refunds.status, "pending_approval"),
                  eq(pg.refunds.status, "approved"),
                  eq(pg.refunds.status, "processing"),
                ),
              ),
            ),
        );
        const remaining = order.refundableAmount - opts.amount;
        const status = remaining <= 0 ? "refunded" : "partially_refunded";
        let id: string;
        if (existing) {
          id = existing.id;
          await tx.update(pg.refunds).set({ status: "completed", processedAt: Date.now() }).where(eq(pg.refunds.id, existing.id));
        } else {
          id = genId("REF");
          await tx.insert(pg.refunds).values({
            id, orderId: order.id, customerId: order.customerId, amount: opts.amount, reason: "Approved refund",
            status: "completed", approvalId: null, idempotencyKey: null, createdAt: Date.now(), processedAt: Date.now(),
          });
        }
        await tx.update(pg.orders).set({ refundableAmount: Math.max(0, remaining), status }).where(eq(pg.orders.id, order.id));
        return id;
      });
      return (await pgOne(db.select().from(pg.refunds).where(eq(pg.refunds.id, refundId)))) as RefundRow;
    },
    principalOf: async (id) => {
      const row = await pgOne(db.select().from(pg.customers).where(eq(pg.customers.id, id)));
      if (!row) return undefined;
      return { id: row.id, name: row.name, email: row.email, role: row.role as Principal["role"] };
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Atomic refund application                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The refund write is done atomically per-driver so each can use the correct
 * transaction style. SQLite: better-sqlite3's `transaction()` callback MUST be
 * synchronous (the driver rejects a returned promise). Postgres: the callback
 * is async. The logic (complete pending row + decrement order balance) is
 * identical in both.
 */

/* -------------------------------------------------------------------------- */
/*  Driver selection                                                          */
/* -------------------------------------------------------------------------- */

let cached: Repo | null = null;
/** Active Repo, choosing SQLite or Postgres from DATABASE_URL. */
export function getRepo(): Repo {
  if (!cached) {
    cached = dbMode() === "postgres" ? createPostgresRepo(getPostgresDb()) : createSqliteRepo(getDb());
  }
  return cached;
}
/** Tests / re-init can force a rebuild. */
export function resetRepoCache(): void {
  cached = null;
}
