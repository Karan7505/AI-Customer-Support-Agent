import { z } from "zod";
import { deps, json, httpError, apiRequest } from "../../_util";
import { createAuditor } from "@/lib/audit";
import { resetPassword } from "@/lib/auth";
import { passwordMinLength } from "@/lib/env";

export const runtime = "nodejs";

const ResetInput = z.object({
  token: z.string().min(8).max(128),
  newPassword: z.string().min(passwordMinLength()).max(128),
});

/**
 * POST /api/auth/reset-password — public.
 * Consumes a 1h single-use reset token: sets the new password and revokes ALL
 * sessions for the account.
 */
export async function POST(req: Request) {
  return apiRequest(req, "POST", "/api/auth/reset-password", async () => {
    const parsed = ResetInput.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.issues.map((i) => i.message).join("; ") } },
        { status: 400 },
      );
    }
    try {
      const { repo } = deps();
      await resetPassword(repo, createAuditor(repo), parsed.data.token, parsed.data.newPassword);
      return json({ ok: true, message: "Password updated. You can sign in with your new password." });
    } catch (e) {
      return httpError(e);
    }
  });
}
