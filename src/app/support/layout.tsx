import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPrincipal, SESSION_COOKIE } from "@/lib/auth";
import { getRepo } from "@/db/repos";

/**
 * Server-side gate (audit F16): staff-only dashboard. Unauthenticated visitors
 * are redirected at the RSC layer; non-staff roles are sent back to chat.
 * Every data API behind this page re-checks the role (defense in depth).
 */
export default async function SupportLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const principal = token ? await getPrincipal(getRepo(), token) : null;
  if (!principal) redirect("/login");
  if (principal.role !== "admin" && principal.role !== "support_agent") redirect("/chat");
  return children;
}
