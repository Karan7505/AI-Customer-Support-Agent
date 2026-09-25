import { NextResponse } from "next/server";
import { z } from "zod";
import { deps, json, httpError, currentPrincipal, apiRequest } from "../_util";
import { createAgent } from "@/lib/agent";
import { createLlmClient } from "@/lib/llm-factory";
import { Errors } from "@/lib/errors";
import { allowRequest, llmDailyCostExceeded, recordLlmDailyCost } from "@/lib/rate-limit";
import { envInt, rateLimitMsgPerHour } from "@/lib/env";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const ChatBody = z.object({ message: z.string().min(1).max(4000) });

export async function POST(req: Request) {
  return apiRequest(req, "POST", "/api/chat", async () => {
    try {
      const principal = await currentPrincipal();
      if (!principal) throw Errors.unauthorized("Sign in required.");

      // Hourly per-customer message cap (blueprint §7.6, default 20/hour).
      // Checked first (strictest sustained rate) so a rejected turn does not
      // consume the short-window spike cap below.
      if (!allowRequest(`msg:${principal.id}`, rateLimitMsgPerHour(), 60 * 60 * 1000)) {
        logger.warn("rate limit hit", { scope: "msg", customerId: principal.id });
        return NextResponse.json(
          { error: { code: "RATE_LIMITED", message: "You've reached the message limit for this hour. Please try again soon." } },
          { status: 429 },
        );
      }

      // Daily LLM spend cap (blueprint §7.6, default $50/customer/day).
      if (llmDailyCostExceeded(principal.id)) {
        logger.warn("rate limit hit", { scope: "llm_daily_cost", customerId: principal.id });
        return NextResponse.json(
          { error: { code: "DAILY_COST_LIMIT", message: "The daily AI budget for this account was reached. Please try again tomorrow." } },
          { status: 429 },
        );
      }

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
      // Feed the daily LLM spend guard (blueprint §7.6).
      recordLlmDailyCost(principal.id, result.llmCostCents);

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
  });
}
