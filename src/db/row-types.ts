/**
 * Driver-agnostic row shapes. Both the SQLite and Postgres adapters return
 * these exact objects, so the rest of the app never sees a driver type.
 * Monetary values are integer cents; timestamps are epoch milliseconds.
 * `role` is a plain string (drizzle infers `string` for text columns); callers
 * cast to the Role union where needed.
 */

export interface CustomerRow {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: string;
  createdAt: number;
  /** 1 = email verified (existing/seed rows backfill to 1). */
  emailVerified: number;
  emailVerificationToken: string | null;
  emailVerificationSentAt: number | null;
  emailResetToken: string | null;
  emailResetSentAt: number | null;
  /** Soft-delete marker (epoch ms); set => deactivated. */
  deactivatedAt: number | null;
}

export interface OrderRow {
  id: string;
  customerId: string;
  status: string;
  total: number;
  currency: string;
  items: string;
  shippingAddress: string;
  trackingNumber: string | null;
  externalTrackingId: string | null;
  stripePaymentIntentId: string | null;
  createdAt: number;
  deliveredAt: number | null;
  refundableAmount: number;
}

export interface TicketNote {
  author: string;
  authorRole: string;
  content: string;
  at: number;
}

export interface SupportTicketRow {
  id: string;
  customerId: string;
  orderId: string | null;
  subject: string;
  description: string;
  priority: string;
  status: string;
  /** JSON string of TicketNote[] (agent-only handling thread). */
  internalNotes: string | null;
  /** Deterministic dedupe key (blueprint §8.2); null for pre-migration rows. */
  idempotencyKey: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RefundRow {
  id: string;
  orderId: string;
  customerId: string;
  amount: number;
  reason: string;
  status: string;
  approvalId: string | null;
  idempotencyKey: string | null;
  providerRefundId: string | null;
  createdAt: number;
  processedAt: number | null;
}

export interface ApprovalRequestRow {
  id: string;
  requestedBy: string;
  actorRole: string;
  actionType: string;
  toolName: string;
  arguments: string;
  riskLevel: string;
  status: string;
  approvedBy: string | null;
  rejectionReason: string | null;
  orderId: string | null;
  amountCents: number | null;
  idempotencyKey: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface AuditLogRow {
  id: number;
  actorId: string;
  actorRole: string;
  action: string;
  toolName: string | null;
  arguments: string | null;
  result: string | null;
  approvalId: string | null;
  conversationId: string | null;
  timestamp: number;
  /**
   * Observability context (blueprint §10.4). Stored as TEXT on SQLite (a JSON
   * string) and as JSONB on Postgres (postgres-js returns a parsed object),
   * so the shared type is `unknown` — consumers parse/display, never query.
   */
  metadata: unknown;
  /** "success" | "failure" | null (typed as string: null for driver-agnostic rows). */
  status: string | null;
  durationMs: number | null;
}

export interface SessionRow {
  token: string;
  customerId: string;
  createdAt: number;
  expiresAt: number;
  lastActivityAt: number | null;
}

export interface ConversationRow {
  id: string;
  customerId: string;
  title: string;
  createdAt: number;
}

export interface MessageRow {
  id: number;
  conversationId: string;
  role: string;
  content: string;
  meta: string | null;
  createdAt: number;
}
