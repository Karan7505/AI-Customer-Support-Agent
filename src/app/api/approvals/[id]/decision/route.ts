import { deps, json, requireRole, httpError } from "../../../_util";
import { createAuditor } from "@/lib/audit";
import { decideApproval, executeApprovedAction } from "@/lib/approvals";
import { ROLE_ADMIN } from "@/db/schema";
import { withContext } from "../../helpers";
import { z } from "zod";

export const runtime = "nodejs";

const DecisionBody = z.object({
  approve: z.boolean(),
  reason: z.string().max(500).optional(),
});

/**
 * POST /api/approvals/:id/decision  { approve, reason? }
 * On approve, the approved action is executed immediately and exactly once.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const principal = await requireRole([ROLE_ADMIN]);
  if ("error" in principal) return principal.error;
  try {
    const { id } = await ctx.params;
    const body = DecisionBody.parse(await req.json());
    const { repo } = deps();
    const auditor = createAuditor(repo);

    const decision = await decideApproval(repo, auditor, principal, {
      approvalId: id,
      approve: body.approve,
      reason: body.reason,
    });

    let refund = null;
    if (body.approve) {
      const { refund: r } = await executeApprovedAction(repo, auditor, principal, id);
      refund = r;
    }

    return json({
      ok: true,
      approval: await withContext(repo, auditor, decision),
      refund,
    });
  } catch (e) {
    return httpError(e);
  }
}
