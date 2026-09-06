import { deps, json, requireRole, httpError } from "../_util";
import { ROLE_ADMIN } from "@/db/schema";
import { parseJson } from "@/lib/util";

export const runtime = "nodejs";

/** GET /api/audit?limit=100 - full audit trail (admin only). */
export async function GET(req: Request) {
  const principal = await requireRole([ROLE_ADMIN]);
  if ("error" in principal) return principal.error;
  try {
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 500);
    const { repo } = deps();
    const rows = repo.listAudit({ limit });
    const items = rows.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      actorRole: r.actorRole,
      action: r.action,
      toolName: r.toolName,
      arguments: parseJson(r.arguments, null),
      result: parseJson(r.result, null),
      approvalId: r.approvalId,
      conversationId: r.conversationId,
      timestamp: r.timestamp,
    }));
    return json({ entries: items });
  } catch (e) {
    return httpError(e);
  }
}
