import { z } from "zod";
import { deps, json, requireRole, apiRequest } from "../../_util";
import { createAuditor } from "@/lib/audit";
import { ROLE_ADMIN } from "@/db/schema";

export const runtime = "nodejs";

const SoftDeleteInput = z.object({
  customerId: z.string().trim().min(2).max(64),
});

/**
 * POST /api/admin/soft-delete-customer — admin only.
 * Erasure endpoint (GDPR/CCPA, blueprint §6.6): soft-deletes the customer's
 * erasable data (customer row, orders, tickets, conversations, messages).
 * Refunds are retained forever (financial records) and audit history follows
 * the audit retention policy. Soft-deleted rows are excluded from every
 * read path (src/db/repos.ts).
 */
export async function POST(req: Request) {
  return apiRequest(req, "POST", "/api/admin/soft-delete-customer", async () => {
    const { repo } = deps();
    const principal = await requireRole([ROLE_ADMIN]);
    if ("error" in principal) return principal.error;
    const parsed = SoftDeleteInput.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.issues.map((i) => i.message).join("; ") } },
        { status: 400 },
      );
    }
    const { customerId } = parsed.data;
    const counts = await repo.softDeleteCustomerData(customerId);
    const auditor = createAuditor(repo);
    await auditor.log(
      { actor: principal },
      "customer.data_soft_deleted",
      {
        toolName: "soft_delete_customer_data",
        arguments: { customerId },
        result: counts,
        status: "success",
        metadata: { deletedAt: Date.now() },
      },
    );
    return json({
      ok: true,
      deleted: true,
      counts,
      message: "Customer data was soft-deleted and is now hidden from all views.",
    });
  });
}
