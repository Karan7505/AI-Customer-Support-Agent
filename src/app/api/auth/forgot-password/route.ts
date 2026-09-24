import { z } from "zod";
import { deps, json, apiRequest } from "../../_util";
import { createAuditor } from "@/lib/audit";
import { requestPasswordReset } from "@/lib/auth";

export const runtime = "nodejs";

const ForgotInput = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
});

/**
 * POST /api/auth/forgot-password — public.
 * Anti-enumeration: the response is IDENTICAL whether or not the account
 * exists. A 1h single-use reset token + email are only produced for real,
 * active accounts.
 */
export async function POST(req: Request) {
  return apiRequest(req, "POST", "/api/auth/forgot-password", async () => {
    const parsed = ForgotInput.safeParse(await req.json().catch(() => null));
    if (parsed.success) {
      try {
        const { repo } = deps();
        await requestPasswordReset(repo, createAuditor(repo), parsed.data.email);
      } catch {
        // Never leak reset-request failures to the caller.
      }
    }
    return json({
      ok: true,
      message: "If that address is registered, a reset link is on its way.",
    });
  });
}
