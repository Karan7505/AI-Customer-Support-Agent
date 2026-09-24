import { z } from "zod";
import { deps, json, httpError, requireRole, apiRequest } from "../../_util";
import { createAuditor } from "@/lib/audit";
import { deactivateUser } from "@/lib/auth";
import { ROLE_ADMIN } from "@/db/schema";

export const runtime = "nodejs";

const DeactivateInput = z.object({
  /** Target customer; defaults to the caller's own account. */
  customerId: z.string().min(3).max(40).optional(),
});

/**
 * POST /api/admin/deactivate-user — admin only.
 * Soft-deactivates a customer account (deactivated_at marker) and revokes all
 * its sessions. The row is retained (soft-delete, never hard-deleted).
 */
export async function POST(req: Request) {
  return apiRequest(req, "POST", "/api/admin/deactivate-user", async () => {
    const { repo } = deps();
    const principal = await requireRole([ROLE_ADMIN]);
    if ("error" in principal) return principal.error;
    const parsed = DeactivateInput.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.issues.map((i) => i.message).join("; ") } },
        { status: 400 },
      );
    }
    const targetId = parsed.data.customerId ?? principal.id;
    try {
      await deactivateUser(repo, createAuditor(repo), principal, targetId);
      return json({ ok: true, customerId: targetId, message: "Account deactivated. All sessions revoked." });
    } catch (e) {
      return httpError(e);
    }
  });
}
