import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * All monetary values are stored as INTEGER cents to avoid float drift.
 * Timestamps are INTEGER epoch milliseconds (sortable, easy date math).
 */

export const ROLE_CUSTOMER = "customer" as const;
export const ROLE_SUPPORT_AGENT = "support_agent" as const;
export const ROLE_ADMIN = "admin" as const;
export type Role =
  (typeof ROLE_CUSTOMER) | (typeof ROLE_SUPPORT_AGENT) | (typeof ROLE_ADMIN);
export const ROLES: Role[] = [
  ROLE_CUSTOMER,
  ROLE_SUPPORT_AGENT,
  ROLE_ADMIN,
];

export const ORDER_STATUS = [
  "pending",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
  "partially_refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

export const TICKET_PRIORITY = ["low", "medium", "high"] as const;
export type TicketPriority = (typeof TICKET_PRIORITY)[number];

export const TICKET_STATUS = ["open", "in_progress", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUS)[number];

export const REFUND_STATUS = [
  "requested",
  "pending_approval",
  "approved",
  "rejected",
  "processing",
  "completed",
  "failed",
] as const;
export type RefundStatus = (typeof REFUND_STATUS)[number];

export const APPROVAL_STATUS = [
  "pending_approval",
  "approved",
  "rejected",
  "expired",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS)[number];

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * Principal table. Customers, support agents and admins all live here so a
 * session and an audit entry can always resolve an actor + role.
 */
export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(), // e.g. CUST-1001
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default(ROLE_CUSTOMER),
  createdAt: integer("created_at").notNull(),
});

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(), // e.g. ORD-1001
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    status: text("status").notNull().default("pending"),
    total: integer("total").notNull(), // cents
    currency: text("currency").notNull().default("USD"),
    items: text("items").notNull(), // JSON array
    shippingAddress: text("shipping_address").notNull(), // JSON
    trackingNumber: text("tracking_number"),
    createdAt: integer("created_at").notNull(),
    deliveredAt: integer("delivered_at"),
    refundableAmount: integer("refundable_amount").notNull(), // remaining refundable cents
  },
  (t) => [index("idx_orders_customer").on(t.customerId)],
);

export const supportTickets = sqliteTable(
  "support_tickets",
  {
    id: text("id").primaryKey(), // e.g. TCK-1001
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    orderId: text("order_id"),
    subject: text("subject").notNull(),
    description: text("description").notNull(),
    priority: text("priority").notNull().default("medium"),
    status: text("status").notNull().default("open"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_tickets_customer").on(t.customerId)],
);

export const refunds = sqliteTable(
  "refunds",
  {
    id: text("id").primaryKey(), // e.g. REF-1001
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    amount: integer("amount").notNull(), // cents
    reason: text("reason").notNull(),
    status: text("status").notNull().default("requested"),
    approvalId: text("approval_id"),
    idempotencyKey: text("idempotency_key"),
    createdAt: integer("created_at").notNull(),
    processedAt: integer("processed_at"),
  },
  (t) => [
    index("idx_refunds_order").on(t.orderId),
    uniqueIndex("uq_refunds_idempotency").on(t.idempotencyKey),
  ],
);

export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(), // e.g. APR-1001
    requestedBy: text("requested_by")
      .notNull()
      .references(() => customers.id),
    actorRole: text("actor_role").notNull(),
    actionType: text("action_type").notNull(), // e.g. "refund"
    toolName: text("tool_name").notNull(), // e.g. "process_refund"
    arguments: text("arguments").notNull(), // exact bound arguments (JSON)
    riskLevel: text("risk_level").notNull().default("high"),
    status: text("status").notNull().default("pending_approval"),
    approvedBy: text("approved_by"),
    rejectionReason: text("rejection_reason"),
    orderId: text("order_id"),
    amountCents: integer("amount_cents"),
    idempotencyKey: text("idempotency_key"), // binds approval to one execution
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [index("idx_approvals_status").on(t.status)],
);

export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorId: text("actor_id").notNull(),
  actorRole: text("actor_role").notNull(),
  action: text("action").notNull(), // human-readable summary
  toolName: text("tool_name"),
  arguments: text("arguments"), // JSON
  result: text("result"), // JSON
  approvalId: text("approval_id"),
  conversationId: text("conversation_id"),
  timestamp: integer("timestamp").notNull(),
});

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    title: text("title").notNull().default("New conversation"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_conv_customer").on(t.customerId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text("role").notNull(), // user | assistant | tool | system
    content: text("content").notNull(),
    meta: text("meta"), // JSON: tool name, structured result, card payload
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_messages_conv").on(t.conversationId)],
);

export type CustomerRow = typeof customers.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type SupportTicketRow = typeof supportTickets.$inferSelect;
export type RefundRow = typeof refunds.$inferSelect;
export type ApprovalRequestRow = typeof approvalRequests.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
