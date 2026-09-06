import { z } from "zod";

/**
 * Runtime schemas for every tool's INPUT and OUTPUT.
 * LLM-generated payloads are never passed to the DB/DB APIs directly - they
 * are parsed/validated here first. Excess-unknown fields are stripped.
 */

const orderId = z
  .string()
  .min(4)
  .max(24)
  .regex(/^[A-Za-z]{2,6}-\d+$/, "Order id must look like ORD-1234");

export const GetOrderInput = z
  .object({ orderId })
  .strict();

export const ListCustomerOrdersInput = z.object({}).strict();

export const GetTrackingStatusInput = z
  .object({ orderId })
  .strict();

export const CreateSupportTicketInput = z
  .object({
    orderId: orderId.optional(),
    /** Target customer. Staff may set it; customers are locked to themselves. */
    customerId: z.string().min(4).max(32).optional(),
    subject: z.string().min(3).max(140),
    description: z.string().min(3).max(2000),
    priority: z.enum(["low", "medium", "high"]),
  })
  .strict();

export const RequestRefundInput = z
  .object({
    orderId,
    // Accept a number; we round to cents on the policy side.
    amount: z.number().int().positive().max(10_000_000).optional(),
    reason: z.string().min(3).max(300),
    /**
     * Target customer, REQUIRED for staff (support/admin) initiating a refund
     * on a customer's behalf. Customers refund their own account only - the
     * tool rejects a customer-supplied customerId that differs from the caller.
     */
    customerId: z.string().min(4).max(32).optional(),
  })
  .strict();

export const SearchCustomersInput = z
  .object({
    query: z.string().min(2).max(120),
    limit: z.number().int().min(1).max(25).optional(),
  })
  .strict();

export const ListOrdersInput = z
  .object({
    customerId: z.string().min(4).max(32).optional(),
    status: z
      .enum(["pending", "processing", "shipped", "delivered", "cancelled", "refunded", "partially_refunded"])
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const ListTicketsInput = z
  .object({
    status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
    customerId: z.string().min(4).max(32).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const UpdateSupportTicketInput = z
  .object({
    ticketId: z.string().min(4).max(32),
    status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    note: z.string().min(3).max(500).optional(),
  })
  .strict();

export const ProcessRefundInput = z
  .object({
    orderId,
    amount: z.number().int().positive().max(10_000_000),
    reason: z.string().min(3).max(300),
    approvalId: z.string().min(6).max(24),
  })
  .strict();

export const LookupPolicyInput = z
  .object({
    query: z.string().min(2).max(500),
  })
  .strict();

export type GetOrderInputT = z.infer<typeof GetOrderInput>;
export type ListCustomerOrdersInputT = z.infer<typeof ListCustomerOrdersInput>;
export type GetTrackingStatusInputT = z.infer<typeof GetTrackingStatusInput>;
export type CreateSupportTicketInputT = z.infer<typeof CreateSupportTicketInput>;
export type RequestRefundInputT = z.infer<typeof RequestRefundInput>;
export type ProcessRefundInputT = z.infer<typeof ProcessRefundInput>;
export type LookupPolicyInputT = z.infer<typeof LookupPolicyInput>;
export type SearchCustomersInputT = z.infer<typeof SearchCustomersInput>;
export type ListOrdersInputT = z.infer<typeof ListOrdersInput>;
export type ListTicketsInputT = z.infer<typeof ListTicketsInput>;
export type UpdateSupportTicketInputT = z.infer<typeof UpdateSupportTicketInput>;

// ---- Output schemas --------------------------------------------------------

export const OrderOut = z.object({
  id: z.string(),
  customerId: z.string(),
  status: z.enum([
    "pending",
    "processing",
    "shipped",
    "delivered",
    "cancelled",
    "refunded",
    "partially_refunded",
  ]),
  total: z.number().int(),
  currency: z.string(),
  items: z.array(
    z.object({ name: z.string(), qty: z.number().int(), priceCents: z.number().int() }),
  ),
  shippingAddress: z.object({
    line1: z.string(),
    line2: z.string().optional(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
    country: z.string(),
  }),
  trackingNumber: z.string().nullable(),
  createdAt: z.number().int(),
  deliveredAt: z.number().int().nullable(),
  refundableAmount: z.number().int(),
});

export const TrackingOut = z.object({
  orderId: z.string(),
  trackingNumber: z.string().nullable(),
  status: z.string(),
  events: z.array(
    z.object({ location: z.string(), description: z.string(), at: z.number().int() }),
  ),
  eta: z.string().nullable(),
  delivered: z.boolean(),
});

export const TicketOut = z.object({
  id: z.string(),
  customerId: z.string(),
  orderId: z.string().nullable(),
  subject: z.string(),
  description: z.string(),
  priority: z.enum(["low", "medium", "high"]),
  status: z.enum(["open", "in_progress", "resolved", "closed"]),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const RefundOut = z.object({
  id: z.string(),
  orderId: z.string(),
  customerId: z.string(),
  amount: z.number().int(),
  reason: z.string(),
  status: z.enum([
    "requested",
    "pending_approval",
    "approved",
    "rejected",
    "processing",
    "completed",
    "failed",
  ]),
  approvalId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  createdAt: z.number().int(),
  processedAt: z.number().int().nullable(),
});

export const PolicyOut = z.object({
  topic: z.string(),
  text: z.string(),
  citation: z.object({ source: z.string(), id: z.string(), title: z.string() }),
});

export const RefundRequestOut = z.object({
  status: z.enum(["pending_approval", "rejected"]),
  approvalId: z.string().nullable(),
  orderId: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  message: z.string(),
});
