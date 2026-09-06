import { deps, json, requireRole, httpError } from "../_util";
import { createAuditor } from "@/lib/audit";
import { mapApproval } from "@/lib/approvals";
import { ROLE_ADMIN, ROLE_SUPPORT_AGENT } from "@/db/schema";
import { withContext } from "./helpers";

export const runtime = "nodejs";

const VIEWER_ROLES = [ROLE_ADMIN, ROLE_SUPPORT_AGENT];

/** GET /api/approvals?status=pending_approval|all */
export async function GET(req: Request) {
  const principal = await requireRole(VIEWER_ROLES);
  if ("error" in principal) return principal.error;
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? "all";
    const { repo } = deps();
    const auditor = createAuditor(repo);
    let rows = repo.listApprovals({ limit: 200 });
    if (status !== "all") rows = rows.filter((r) => r.status === status);

    // Admin sees all; support agent sees only their own requests (self-view).
    let mine = rows;
    if (principal.role === ROLE_SUPPORT_AGENT) {
      mine = rows.filter((r) => r.requestedBy === principal.id);
    }

    const items = mine.map((r) => withContext(repo, auditor, mapApproval(r)));
    return json({ approvals: items });
  } catch (e) {
    return httpError(e);
  }
}
