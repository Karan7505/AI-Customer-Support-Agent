import { cookies } from "next/headers";
import { deps, json, clearSessionCookie, apiRequest } from "../../_util";
import { SESSION_COOKIE, logout } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return apiRequest(req, "POST", "/api/auth/logout", async () => {
    // Require a JSON body: cross-site form POSTs (CSRF) can only send
    // text/plain/multipart, so they are rejected below. Same-origin clients
    // always send application/json via the api() helper.
    const parsed = await req.json().catch(() => null);
    if (parsed === null) {
      return json({ error: { code: "VALIDATION_ERROR", message: "Expected a JSON body." } }, { status: 400 });
    }
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value ?? "";
    const { repo } = deps();
    await logout(repo, token);
    const res = json({ ok: true });
    clearSessionCookie(res);
    return res;
  });
}
