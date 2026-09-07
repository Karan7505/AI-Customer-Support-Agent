import { cookies } from "next/headers";
import { deps, json, clearSessionCookie } from "../../_util";
import { SESSION_COOKIE, logout } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const { repo } = deps();
  await logout(repo, token ?? "");
  return clearSessionCookie(json({ ok: true }));
}
