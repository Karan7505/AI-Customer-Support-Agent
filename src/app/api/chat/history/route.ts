import { deps, json, currentPrincipal, httpError } from "../../_util";
import { Errors } from "@/lib/errors";
import { parseJson } from "@/lib/util";

export const runtime = "nodejs";

/** GET /api/chat/history - the signed-in principal's conversation messages. */
export async function GET() {
  try {
    const principal = await currentPrincipal();
    if (!principal) throw Errors.unauthorized();
    const { repo } = deps();
    const conv = repo.getOrCreateConversation(principal.id);
    const messages = repo.listMessages(conv.id).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      meta: m.meta ? parseJson(m.meta, null) : null,
      createdAt: m.createdAt,
    }));
    return json({ messages });
  } catch (e) {
    return httpError(e);
  }
}
