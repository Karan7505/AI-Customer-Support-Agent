import { z } from "zod";
import { deps, json, httpError, currentPrincipal } from "../_util";
import { createAgent } from "@/lib/agent";
import { createLlmClient } from "@/lib/llm-factory";
import { Errors } from "@/lib/errors";

export const runtime = "nodejs";

const ChatBody = z.object({ message: z.string().min(1).max(4000) });

export async function POST(req: Request) {
  try {
    const principal = await currentPrincipal();
    if (!principal) throw Errors.unauthorized("Sign in required.");

    const body = ChatBody.parse(await req.json());
    const { repo } = deps();
    const agent = createAgent(repo, createLlmClient());

    const result = await agent.runTurn({
      principal,
      userText: body.message,
    });

    return json({
      ok: true,
      assistant: result.assistantText,
      cards: result.cards,
      structured: result.structured ?? null,
      events: result.events.map((e) =>
        e.type === "tool_result"
          ? { type: e.type, toolName: e.toolName, ok: (e.result as any).ok }
          : e,
      ),
    });
  } catch (e) {
    return httpError(e);
  }
}
