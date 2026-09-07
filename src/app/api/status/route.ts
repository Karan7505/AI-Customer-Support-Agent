import { deps, json, currentPrincipal, httpError } from "../_util";
import { mapApproval } from "@/lib/approvals";
import { mapRefund } from "@/lib/refund-execution";
import { Errors } from "@/lib/errors";

export const runtime = "nodejs";

/**
 * GET /api/status - customer-specific live state:
 *  - their approvals (so they see "waiting for approval")
 *  - their refunds with current status
 *  - whether any of their actions is currently awaiting approval
 */
export async function GET() {
  try {
    const principal = await currentPrincipal();
    if (!principal) throw Errors.unauthorized();
    const { repo } = deps();

    const approvals = (await repo.listApprovals({ limit: 200 }))
      .filter((a) => a.requestedBy === principal.id)
      .map(mapApproval);

    const refunds = (await repo.getRefundsByCustomer(principal.id)).map(mapRefund);
    const pending = approvals.filter((a) => a.status === "pending_approval");

    return json({
      ok: true,
      awaitingApproval: pending.length > 0,
      approvals,
      refunds,
    });
  } catch (e) {
    return httpError(e);
  }
}
