import { currentPrincipal, json } from "../../_util";

export const runtime = "nodejs";

export async function GET() {
  const p = await currentPrincipal();
  if (!p) return json({ user: null }, { status: 401 });
  return json({ user: { id: p.id, name: p.name, email: p.email, role: p.role } });
}
