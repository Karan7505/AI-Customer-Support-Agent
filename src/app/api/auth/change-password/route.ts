import { z } from "zod";
import { deps, json, httpError, currentPrincipal, setSessionCookie, apiRequest } from "../../_util";
import { createAuditor } from "@/lib/audit";
import { changePassword } from "@/lib/auth";
import { passwordMinLength } from "@/lib/env";

export const runtime = "nodejs";

const ChangePasswordInput = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(passwordMinLength()).max(128),
});

/**
 * POST /api/auth/change-password — authenticated.
 * Verifies the current password, sets the new one, and ROTATES sessions:
 * every existing session for the account is revoked and the caller receives a
 * fresh session cookie (set with the new expiry).
 */
export async function POST(req: Request) {
  return apiRequest(req, "POST", "/api/auth/change-password", async () => {
    const { repo } = deps();
    const principal = await currentPrincipal();
    if (!principal) {
      return json({ error: { code: "UNAUTHORIZED", message: "Please sign in." } }, { status: 401 });
    }
    const parsed = ChangePasswordInput.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.issues.map((i) => i.message).join("; ") } },
        { status: 400 },
      );
    }
    try {
      const row = await repo.getCustomer(principal.id);
      if (!row) {
        return json({ error: { code: "UNAUTHORIZED", message: "Session no longer valid." } }, { status: 401 });
      }
      const result = await changePassword(repo, createAuditor(repo), row, parsed.data.currentPassword, parsed.data.newPassword);
      const res = json({ ok: true, message: "Password updated. All other sessions were signed out." });
      setSessionCookie(res, result.token, result.expiresAt);
      return res;
    } catch (e) {
      return httpError(e);
    }
  });
}
