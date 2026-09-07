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
}

export interface SessionRow {
  token: string;
  customerId: string;
  createdAt: number;
  expiresAt: number;
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
