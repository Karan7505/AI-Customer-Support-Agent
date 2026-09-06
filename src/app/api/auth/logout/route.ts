import { cookies } from "next/headers";
import { deps, json, clearSessionCookie } from "../../_util";
import { SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const { repo } = deps();
  repo.revokeSession(token ?? "");
  return clearSessionCookie(json({ ok: true }));
}
