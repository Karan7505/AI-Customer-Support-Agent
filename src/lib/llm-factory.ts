import { createMockLlm } from "./mock";
import { createOpenAiLlm } from "./openai";
import { llmMode, logRuntimeMode } from "./env";
import { logger } from "./logger";
import { recordLlmCall } from "./metrics";
import type { LlmClient, LlmMessage, LlmPlan, LlmTool } from "./llm";

/**
 * Wrap a real LLM client so a total provider failure (after its own retries)
 * degrades to the deterministic mock planner instead of a hard error
 * (blueprint §5.1). Only used when a real key is configured — without a key
 * llmMode() is "mock" and no fallback/warning ever fires.
 */
function withMockFallback(primary: LlmClient, fallback: LlmClient): LlmClient {
  return {
    provider: primary.provider,
    model: primary.model,
    async plan(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmPlan> {
      const t0 = Date.now();
      try {
        return await primary.plan(messages, tools);
      } catch (e) {
        recordLlmCall(primary.model, "fallback", Date.now() - t0);
        logger.warn("llm provider failed; falling back to mock", {
          provider: primary.provider,
          model: primary.model,
          error: e instanceof Error ? e.message : String(e),
        });
        return fallback.plan(messages, tools);
      }
    },
  };
}

/**
 * Choose the LLM backend. Auto-switches: OpenAI when OPENAI_API_KEY is present
 * (or LLM_PROVIDER=openai), otherwise the deterministic mock planner.
 * Logs which mode is active once per process.
 */
export function createLlmClient(): LlmClient {
  logRuntimeMode();
  if (llmMode() === "openai") {
    return withMockFallback(createOpenAiLlm(), createMockLlm());
  }
  return createMockLlm();
}
