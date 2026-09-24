import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPrincipal, SESSION_COOKIE } from "@/lib/auth";
import { getRepo } from "@/db/repos";

/**
 * Server-side gate (audit F16): the page shell is a client component, but
 * unauthenticated visitors must never even receive it — redirect at the RSC
 * layer. Role is re-checked by every data API as well (defense in depth).
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const principal = token ? await getPrincipal(getRepo(), token) : null;
  if (!principal) redirect("/login");
  if (principal.role !== "admin") redirect("/chat");
  return children;
}
