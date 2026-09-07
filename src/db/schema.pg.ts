import { pgTable, text, integer, serial, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Postgres/Supabase schema (used when DATABASE_URL is set).
 * Column names are camelCase so $inferSelect maps directly onto the shared
 * row types in ./row-types. Monetary values are integer cents; timestamps are
 * epoch milliseconds. Mirrors the SQLite schema in ./schema.
 */

export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("passwordHash").notNull(),
  role: text("role").notNull().default("customer"),
  createdAt: integer("createdAt").notNull(),
});

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    customerId: text("customerId").notNull().references(() => customers.id),
    status: text("status").notNull().default("pending"),
    total: integer("total").notNull(),
    currency: text("currency").notNull().default("USD"),
    items: text("items").notNull(),
    shippingAddress: text("shippingAddress").notNull(),
    trackingNumber: text("trackingNumber"),
    createdAt: integer("createdAt").notNull(),
    deliveredAt: integer("deliveredAt"),
    refundableAmount: integer("refundableAmount").notNull(),
  },
  (t) => [index("idx_orders_customer").on(t.customerId)],
);

export const supportTickets = pgTable(
  "support_tickets",
  {
    id: text("id").primaryKey(),
    customerId: text("customerId").notNull().references(() => customers.id),
    orderId: text("orderId"),
    subject: text("subject").notNull(),
    description: text("description").notNull(),
    priority: text("priority").notNull().default("medium"),
    status: text("status").notNull().default("open"),
    /** JSON array of {author, authorRole, content, at} — agent handling thread. */
    internalNotes: text("internalNotes"),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [index("idx_tickets_customer").on(t.customerId)],
);

export const refunds = pgTable(
  "refunds",
  {
    id: text("id").primaryKey(),
    orderId: text("orderId").notNull().references(() => orders.id),
    customerId: text("customerId").notNull().references(() => customers.id),
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("requested"),
    approvalId: text("approvalId"),
    idempotencyKey: text("idempotencyKey"),
    createdAt: integer("createdAt").notNull(),
    processedAt: integer("processedAt"),
  },
  (t) => [
    index("idx_refunds_order").on(t.orderId),
    uniqueIndex("uq_refunds_idempotency").on(t.idempotencyKey),
  ],
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    requestedBy: text("requestedBy").notNull().references(() => customers.id),
    actorRole: text("actorRole").notNull(),
    actionType: text("actionType").notNull(),
    toolName: text("toolName").notNull(),
    arguments: text("arguments").notNull(),
    riskLevel: text("riskLevel").notNull().default("high"),
    status: text("status").notNull().default("pending_approval"),
    approvedBy: text("approvedBy"),
    rejectionReason: text("rejectionReason"),
    orderId: text("orderId"),
    amountCents: integer("amountCents"),
    idempotencyKey: text("idempotencyKey"),
    createdAt: integer("createdAt").notNull(),
    resolvedAt: integer("resolvedAt"),
  },
  (t) => [index("idx_approvals_status").on(t.status)],
);

// NOTE: "arguments"/"result" are fine as identifiers in Postgres (not reserved).
export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  actorId: text("actorId").notNull(),
  actorRole: text("actorRole").notNull(),
  action: text("action").notNull(),
  toolName: text("toolName"),
  arguments: text("arguments"),
  result: text("result"),
  approvalId: text("approvalId"),
  conversationId: text("conversationId"),
  timestamp: integer("timestamp").notNull(),
});

export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  customerId: text("customerId").notNull().references(() => customers.id),
  createdAt: integer("createdAt").notNull(),
  expiresAt: integer("expiresAt").notNull(),
});

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    customerId: text("customerId").notNull().references(() => customers.id),
    title: text("title").notNull().default("New conversation"),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [index("idx_conv_customer").on(t.customerId)],
);

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    conversationId: text("conversationId").notNull().references(() => conversations.id),
    role: text("role").notNull(),
    content: text("content").notNull(),
    meta: text("meta"),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [index("idx_messages_conv").on(t.conversationId)],
);

export const pgSchema = {
  customers,
  orders,
  supportTickets,
  refunds,
  approvalRequests,
  auditLogs,
  sessions,
  conversations,
  messages,
};
