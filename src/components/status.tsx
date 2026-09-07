// Shared status → label/style maps for the UI so wording is consistent.
import type { ReactNode } from "react";

export interface StatusMeta {
  label: string;
  tone: "neutral" | "info" | "warn" | "success" | "danger" | "pending";
}

export const ORDER_STATUS: Record<string, StatusMeta> = {
  pending: { label: "Pending", tone: "pending" },
  processing: { label: "Processing", tone: "info" },
  shipped: { label: "Shipped", tone: "info" },
  delivered: { label: "Delivered", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  refunded: { label: "Refunded", tone: "success" },
  partially_refunded: { label: "Partially refunded", tone: "warn" },
};

export const REFUND_STATUS: Record<string, StatusMeta> = {
  requested: { label: "Requested", tone: "pending" },
  pending_approval: { label: "Waiting for approval", tone: "warn" },
  approved: { label: "Approved", tone: "info" },
  rejected: { label: "Rejected", tone: "danger" },
  processing: { label: "Refund processing", tone: "info" },
  completed: { label: "Refund completed", tone: "success" },
  failed: { label: "Refund failed", tone: "danger" },
};

export const APPROVAL_STATUS: Record<string, StatusMeta> = {
  pending_approval: { label: "Pending approval", tone: "warn" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  expired: { label: "Expired", tone: "neutral" },
};

export const TICKET_STATUS: Record<string, StatusMeta> = {
  open: { label: "Open", tone: "warn" },
  in_progress: { label: "In progress", tone: "info" },
  resolved: { label: "Resolved", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
};

export const TICKET_PRIORITY: Record<string, StatusMeta> = {
  low: { label: "Low", tone: "neutral" },
  medium: { label: "Medium", tone: "info" },
  high: { label: "High", tone: "danger" },
};

export const RISK_META: Record<string, StatusMeta> = {
  low: { label: "Low risk", tone: "neutral" },
  medium: { label: "Medium risk", tone: "info" },
  high: { label: "High risk", tone: "danger" },
};

const TONE: Record<StatusMeta["tone"], string> = {
  neutral: "bg-slate-500/15 text-slate-300 ring-1 ring-slate-500/30",
  info: "bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30",
  warn: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30",
  success: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30",
  danger: "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30",
  pending: "bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/30",
};

export function StatusPill({ meta, children }: { meta?: StatusMeta; children?: ReactNode }) {
  const m = meta ?? { label: "", tone: "neutral" as const };
  return (
    <span className={`chip ${TONE[m.tone]}`}>{children ?? m.label}</span>
  );
}
