import { createMockLlm } from "./mock";
import { createOpenAiLlm } from "./openai";
import { llmProvider } from "./env";
import type { LlmClient } from "./llm";

/** Choose the LLM backend from env. Default is the deterministic mock. */
export function createLlmClient(): LlmClient {
  return llmProvider() === "openai" ? createOpenAiLlm() : createMockLlm();
}
