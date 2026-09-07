import { createMockLlm } from "./mock";
import { createOpenAiLlm } from "./openai";
import { llmMode, logRuntimeMode } from "./env";
import type { LlmClient } from "./llm";

/**
 * Choose the LLM backend. Auto-switches: OpenAI when OPENAI_API_KEY is present
 * (or LLM_PROVIDER=openai), otherwise the deterministic mock planner.
 * Logs which mode is active once per process.
 */
export function createLlmClient(): LlmClient {
  logRuntimeMode();
  return llmMode() === "openai" ? createOpenAiLlm() : createMockLlm();
}
