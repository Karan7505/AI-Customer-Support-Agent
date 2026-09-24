import { NextResponse } from "next/server";
import { z } from "zod";
import { deps, json, httpError, currentPrincipal } from "../_util";
import { createAgent } from "@/lib/agent";
import { createLlmClient } from "@/lib/llm-factory";
import { Errors } from "@/lib/errors";
import { allowRequest } from "@/lib/rate-limit";
import { envInt } from "@/lib/env";

export const runtime = "nodejs";

const ChatBody = z.object({ message: z.string().min(1).max(4000) });

export async function POST(req: Request) {
  try {
    const principal = await currentPrincipal();
    if (!principal) throw Errors.unauthorized("Sign in required.");

    // Spend/abuse cap: each turn can trigger up to AGENT_MAX_ITERATIONS paid
    // LLM calls, so throttle turns per account (default 60 / 10 min).
    const limit = envInt("CHAT_TURNS_PER_WINDOW", 60);
    const windowMs = envInt("CHAT_WINDOW_MS", 10 * 60 * 1000);
    if (!allowRequest(`chat:${principal.id}`, limit, windowMs)) {
      return NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Too many messages in a short time. Slow down." } },
        { status: 429 },
      );
    }

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
