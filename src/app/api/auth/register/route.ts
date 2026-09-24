import { z } from "zod";
import { deps, json, httpError, apiRequest } from "../../_util";
import { createAuditor } from "@/lib/audit";
import { register } from "@/lib/auth";
import { registrationEnabled, passwordMinLength } from "@/lib/env";

export const runtime = "nodejs";

const RegisterInput = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(passwordMinLength()).max(128),
});

/**
 * POST /api/auth/register — public.
 * CSRF defense follows the app-wide pattern (login/logout): a strict JSON
 * body + SameSite=Lax session cookies (cross-site form POSTs cannot send
 * application/json).
 *
 * Creates a customer account. When EMAIL_VERIFICATION_REQUIRED the account
 * starts unverified and a 24h verification email is queued; login is blocked
 * until verified.
 */
export async function POST(req: Request) {
  return apiRequest(req, "POST", "/api/auth/register", async () => {
    if (!registrationEnabled()) {
      return json({ error: { code: "FORBIDDEN", message: "Registration is disabled." } }, { status: 403 });
    }
    const parsed = RegisterInput.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.issues.map((i) => i.message).join("; ") } },
        { status: 400 },
      );
    }
    try {
      const { repo } = deps();
      const r = await register(repo, createAuditor(repo), parsed.data);
      return json({
        ok: true,
        email: parsed.data.email,
        requiresVerification: r.requiresVerification,
        message: r.requiresVerification
          ? "Account created. Check your inbox to verify your email before signing in."
          : "Account created. You can sign in now.",
      });
    } catch (e) {
      return httpError(e);
    }
  });
}
