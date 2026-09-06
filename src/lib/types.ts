import type {
  ApprovalStatus,
  OrderStatus,
  RefundStatus,
  RiskLevel,
  Role,
  TicketPriority,
  TicketStatus,
} from "@/db/schema";

/** Re-exported for consumer convenience. */
export type { RiskLevel, TicketPriority, Role };

/** Authenticated principal, always resolved server-side from the session. */
export interface Principal {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface OrderItem {
  name: string;
  qty: number;
  priceCents: number;
}

export interface ShippingAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface Order {
  id: string;
  customerId: string;
  status: OrderStatus;
  total: number; // cents
  currency: string;
  items: OrderItem[];
  shippingAddress: ShippingAddress;
  trackingNumber: string | null;
  createdAt: number;
  deliveredAt: number | null;
  refundableAmount: number; // cents remaining
}

export interface TrackingStatus {
  orderId: string;
  trackingNumber: string | null;
  status: string;
  events: { location: string; description: string; at: number }[];
  eta: string | null;
  delivered: boolean;
}

export interface SupportTicket {
  id: string;
  customerId: string;
  orderId: string | null;
  subject: string;
  description: string;
  priority: TicketPriority;
  status: TicketStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Refund {
  id: string;
  orderId: string;
  customerId: string;
  amount: number; // cents
  reason: string;
  status: RefundStatus;
  approvalId: string | null;
  idempotencyKey: string | null;
  createdAt: number;
  processedAt: number | null;
}

export interface ApprovalRequest {
  id: string;
  requestedBy: string;
  actorRole: Role;
  actionType: string;
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  approvedBy: string | null;
  rejectionReason: string | null;
  orderId: string | null;
  amountCents: number | null;
  idempotencyKey: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface AuditEntry {
  id: number;
  actorId: string;
  actorRole: Role;
  action: string;
  toolName: string | null;
  arguments: unknown;
  result: unknown;
  approvalId: string | null;
  conversationId: string | null;
  timestamp: number;
}

/** Envelope every tool returns: never "fake success". */
export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** Events the agent loop streams to the UI / conversation. */
export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "tool_call"; toolName: string; args: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; result: ToolResult }
  | { type: "approval_created"; approval: ApprovalRequest }
  | { type: "refund_result"; refund: Refund }
  | { type: "ticket_result"; ticket: SupportTicket }
  | { type: "order_result"; order: Order; tracking?: TrackingStatus | null }
  | { type: "assistant"; text: string; cards?: AgentCard[] }
  | { type: "error"; code: string; message: string };

/** Rich UI cards the agent may attach to an assistant message. */
export type AgentCard =
  | { kind: "order"; order: Order; tracking?: TrackingStatus | null }
  | {
      kind: "ticket";
      ticket: SupportTicket;
    }
    | {
      kind: "refund";
      status: RefundStatus;
      orderId: string;
      amount: number;
      currency: string;
      approvalId?: string;
      /** Target customer's name (useful when staff act on a customer's behalf). */
      customerName?: string;
      message: string;
    }
  | {
      kind: "approval";
      approvalId: string;
      orderId: string;
      amount: number;
      currency: string;
      message: string;
    };

export interface RefundDecision {
  allowed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}
