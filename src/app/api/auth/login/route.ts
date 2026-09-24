import { NextResponse } from "next/server";
import { z } from "zod";
import { deps, json, httpError, setSessionCookie, clientIp, apiRequest } from "../../_util";
import { login } from "@/lib/auth";
import { allowRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(4) });

// Brute-force throttle: 8 attempts per 10 min per IP and per account.
const LOGIN_LIMIT = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

function rateLimited() {
  return NextResponse.json(
    { error: { code: "RATE_LIMITED", message: "Too many login attempts. Try again later." } },
    { status: 429 },
  );
}

export async function POST(req: Request) {
  return apiRequest(req, "POST", "/api/auth/login", async () => {
    try {
      const body = LoginBody.parse(await req.json());
      const ip = clientIp(req);
      const account = body.email.toLowerCase();
      if (!allowRequest(`login:ip:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS)) return rateLimited();
      if (!allowRequest(`login:acct:${account}`, LOGIN_LIMIT, LOGIN_WINDOW_MS)) return rateLimited();

      let principal;
      let token;
      let expiresAt;
      try {
        const { repo } = deps();
        ({ principal, token, expiresAt } = await login(repo, body.email, body.password));
      } catch (e) {
        // Monitorable signal for alerting; email only — never the password.
        console.warn("[aurora] login_failed", { email: account, ip });
        throw e;
      }
      const res = json({
        ok: true,
        user: { id: principal.id, name: principal.name, email: principal.email, role: principal.role },
      });
      setSessionCookie(res, token, expiresAt);
      return res;
    } catch (e) {
      return httpError(e);
    }
  });
}
