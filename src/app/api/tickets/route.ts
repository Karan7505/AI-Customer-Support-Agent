import { deps, json, requireRole, httpError } from "../_util";
import { parseJson } from "@/lib/util";
import type { TicketNote } from "@/lib/types";
import type { TicketPriority, TicketStatus } from "@/db/schema";
import { TICKET_STATUS } from "@/db/schema";

export const runtime = "nodejs";

const VALID_STATUS = new Set<string>(TICKET_STATUS);

function mapTicket(row: any) {
  return {
    id: row.id,
    customerId: row.customerId,
    orderId: row.orderId,
    subject: row.subject,
    description: row.description,
    priority: row.priority as TicketPriority,
    status: row.status as TicketStatus,
    internalNotes: parseJson<TicketNote[]>(row.internalNotes, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * GET /api/tickets - staff-only ticket list for the support dashboard.
 * Query params: status (optional), limit (default 50, max 100).
 */
export async function GET(req: Request) {
  try {
    const principal = await requireRole(["support_agent", "admin"]);
    if ("error" in principal) return principal.error;

    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? undefined;
    const limitRaw = Number(url.searchParams.get("limit") ?? "50");
    const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 50, 100));

    if (status && !VALID_STATUS.has(status)) {
      return json({ error: { code: "VALIDATION_ERROR", message: `Invalid status: ${status}` } }, { status: 400 });
    }

    const { repo } = deps();
    const rows = await repo.listTickets({ status, limit });
    const ids = [...new Set(rows.map((r) => r.customerId))];
    const customers = new Map<string, { id: string; name: string; email: string }>();
    for (const id of ids) {
      const c = await repo.getCustomer(id);
      if (c) customers.set(c.id, { id: c.id, name: c.name, email: c.email });
    }

    const tickets = rows
      .map((r) => ({
        ...mapTicket(r),
        customer: customers.get(r.customerId) ?? { id: r.customerId, name: r.customerId, email: "" },
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    return json({ ok: true, principal: { id: principal.id, name: principal.name, role: principal.role }, tickets });
  } catch (e) {
    return httpError(e);
  }
}
