import { z } from "zod";
import { deps, json, httpError, setSessionCookie } from "../../_util";
import { login } from "@/lib/auth";

export const runtime = "nodejs";

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(4) });

export async function POST(req: Request) {
  try {
    const body = LoginBody.parse(await req.json());
    const { repo } = deps();
    const { principal, token, expiresAt } = login(repo, body.email, body.password);
    const res = json({
      ok: true,
      user: { id: principal.id, name: principal.name, email: principal.email, role: principal.role },
    });
    setSessionCookie(res, token, expiresAt);
    return res;
  } catch (e) {
    return httpError(e);
  }
}
