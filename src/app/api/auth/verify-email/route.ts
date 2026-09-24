import { z } from "zod";
import { deps, json, httpError, apiRequest } from "../../_util";
import { createAuditor } from "@/lib/audit";
import { verifyEmail } from "@/lib/auth";

export const runtime = "nodejs";

const VerifyInput = z.object({ token: z.string().min(8).max(128) });

/**
 * POST /api/auth/verify-email — public (JSON-body CSRF pattern).
 * Consumes a 24h single-use verification token.
 */
export async function POST(req: Request) {
  return apiRequest(req, "POST", "/api/auth/verify-email", async () => {
    const parsed = VerifyInput.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return json({ error: { code: "TOKEN_INVALID", message: "Invalid verification token." } }, { status: 400 });
    }
    try {
      const { repo } = deps();
      await verifyEmail(repo, createAuditor(repo), parsed.data.token);
      return json({ ok: true, message: "Email verified. You can sign in now." });
    } catch (e) {
      return httpError(e);
    }
  });
}
