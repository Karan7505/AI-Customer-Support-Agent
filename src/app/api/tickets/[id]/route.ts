import { deps, json, requireRole, httpError } from "../../_util";
import { parseJson, nowMs, toJson } from "@/lib/util";
import { Errors } from "@/lib/errors";
import { createAuditor } from "@/lib/audit";
import type { TicketNote } from "@/lib/types";
import { TICKET_PRIORITY, TICKET_STATUS } from "@/db/schema";

export const runtime = "nodejs";

const VALID_STATUS = new Set<string>(TICKET_STATUS);
const VALID_PRIORITY = new Set<string>(TICKET_PRIORITY);

function mapTicket(row: any) {
  return {
    id: row.id,
    customerId: row.customerId,
    orderId: row.orderId,
    subject: row.subject,
    description: row.description,
    priority: row.priority,
    status: row.status,
    internalNotes: parseJson<TicketNote[]>(row.internalNotes, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * GET /api/tickets/[id] - staff-only single ticket with customer + linked order.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireRole(["support_agent", "admin"]);
    if ("error" in principal) return principal.error;
    const { id } = await params;

    const { repo } = deps();
    const row = await repo.getTicket(id);
    if (!row) throw Errors.notFound("Ticket");

    const customer = (await repo.getCustomer(row.customerId)) ?? null;
    const order = row.orderId ? await repo.getOrder(row.orderId) : null;

    return json({
      ok: true,
      ticket: mapTicket(row),
      customer: customer ? { id: customer.id, name: customer.name, email: customer.email } : null,
      order,
    });
  } catch (e) {
    return httpError(e);
  }
}

/**
 * POST /api/tickets/[id] - staff-only update a ticket.
 * Body: { status?: string, priority?: string, note?: string }
 * At least one field is required. Note appends to the agent-only thread.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireRole(["support_agent", "admin"]);
    if ("error" in principal) return principal.error;
    const { id } = await params;

    const body = await req.json().catch(() => ({}));
    const status: string | undefined = body.status;
    const priority: string | undefined = body.priority;
    const note: string | undefined = typeof body.note === "string" ? body.note.trim() : undefined;

    if (status && !VALID_STATUS.has(status)) throw Errors.validation("Invalid ticket status.");
    if (priority && !VALID_PRIORITY.has(priority)) throw Errors.validation("Invalid ticket priority.");
    if (note && (note.length < 3 || note.length > 500)) throw Errors.validation("Note must be 3-500 characters.");
    if (!status && !priority && !note) throw Errors.validation("Provide status, priority, or note.");

    const { repo } = deps();
    const auditor = createAuditor(repo);
    const existing = await repo.getTicket(id);
    if (!existing) throw Errors.notFound("Ticket");

    const t = nowMs();
    const patch: { status?: string; priority?: string; internalNotes?: string; updatedAt: number } = { updatedAt: t };
    if (status) patch.status = status;
    if (priority) patch.priority = priority;
    if (note) {
      const notes = parseJson<TicketNote[]>(existing.internalNotes, []);
      notes.push({ author: principal.name, authorRole: principal.role, content: note, at: t });
      patch.internalNotes = toJson(notes);
    }
    await repo.updateTicket(id, patch);
    const updated = (await repo.getTicket(id))!;
    const ticket = mapTicket(updated);

    const customer = await repo.getCustomer(ticket.customerId);
    await auditor.log(
      { actor: principal, conversationId: null },
      note ? "ticket.note_added" : "ticket.updated",
      {
        toolName: null,
        arguments: { ticketId: id, status, priority, note: note ?? null },
        result: { ticketId: ticket.id, status: ticket.status, priority: ticket.priority },
      },
    );

    return json({ ok: true, ticket, customer: customer ? { id: customer.id, name: customer.name, email: customer.email } : null });
  } catch (e) {
    return httpError(e);
  }
}
