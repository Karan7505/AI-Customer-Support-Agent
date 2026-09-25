import type { LlmClient, LlmMessage, LlmPlan, LlmTool, LlmUsage } from "./llm";
import { Errors } from "./errors";
import { logger } from "./logger";
import { llmTimeoutMs, openaiApiKey, openAiBaseUrl, openAiModel, providerMaxRetries } from "./env";
import { withRetry, errMsg } from "./retry";

/**
 * Real OpenAI-compatible function-calling planner with hardening
 * (blueprint §5.1). Uses global fetch (no SDK). The model only PROPOSES a tool
 * or a final message; the agent loop enforces validation, authorization, risk,
 * approval, and idempotency.
 *
 * Hardening:
 *  - pinned default model gpt-4o-mini (OPENAI_MODEL overrides);
 *  - per-call timeout LLM_TIMEOUT_MS (default 30s);
 *  - structured retries: 3 retries, exponential backoff 1s -> 2s -> 4s, only
 *    for transient failures (408/429/5xx, network, timeout);
 *  - token + cost tracking per call (usage -> agent cost guardrail + audit);
 *  - a total failure surfaces to the caller; llm-factory wraps this client so
 *    it degrades to the mock planner with a warning.
 */

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** $/1M tokens for cost estimation in audit/caps. Unknown models cost 0. */
const MODEL_COST_PER_M: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
};

export function estimateCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const c = MODEL_COST_PER_M[model];
  if (!c) return 0;
  return (inputTokens / 1_000_000) * c.input * 100 + (outputTokens / 1_000_000) * c.output * 100;
}

class LlmHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LlmHttpError";
  }
}

function isRetryable(e: unknown): boolean {
  if (e instanceof LlmHttpError) return RETRYABLE_STATUS.has(e.status);
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return true;
    const m = e.message.toLowerCase();
    return m.includes("fetch failed") || m.includes("econnreset") || m.includes("enotfound") || m.includes("etimedout");
  }
  return false;
}

/**
 * opts are overridable for tests (e.g. a fake baseUrl); by default the
 * standard env config is used (OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL).
 */
export function createOpenAiLlm(opts: { apiKey?: string; baseUrl?: string; model?: string } = {}): LlmClient {
  const apiKey = opts.apiKey ?? openaiApiKey();
  const baseUrl = (opts.baseUrl ?? openAiBaseUrl()).replace(/\/$/, "");
  const model = opts.model ?? openAiModel();

  function parseResponse(parsed: any, usage?: LlmUsage): LlmPlan {
    const choice = parsed?.choices?.[0]?.message;
    if (!choice) throw Errors.tool("Unexpected OpenAI response shape.");
    const tc = choice.tool_calls?.[0];
    if (tc?.function?.name) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }
      return { kind: "tool", tool: tc.function.name, args, toolCallId: tc.id, usage };
    }
    if (typeof choice.content === "string" && choice.content.trim()) {
      return { kind: "final", text: choice.content, usage };
    }
    return {
      kind: "final",
      text: "I'm sorry, I couldn't complete that. Could you try rephrasing?",
      usage,
    };
  }

  async function planOnce(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmPlan> {
    const t0 = Date.now();
    const body = {
      model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content ?? "",
        ...(m.name ? { name: m.name } : {}),
        ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
      })),
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: "auto",
    };

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        // A hung upstream must not hold worker threads/requests open-ended.
        signal: AbortSignal.timeout(llmTimeoutMs()),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      // Timeout/network failures are retryable — rethrow raw so the retry
      // loop can see them; the final error is shaped by the outer caller.
      if (timedOut || isRetryable(e)) throw e;
      throw Errors.tool("LLM request failed.");
    }
    if (!res.ok) {
      throw new LlmHttpError(res.status, `LLM request failed with HTTP ${res.status}.`);
    }
    const parsed = await res.json();
    const usage: LlmUsage | undefined = parsed.usage
      ? {
          inputTokens: parsed.usage.prompt_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? 0,
          costCents:
            Math.round(
              estimateCostCents(model, parsed.usage.prompt_tokens ?? 0, parsed.usage.completion_tokens ?? 0) * 100,
            ) / 100,
        }
      : undefined;
    logger.info("llm response", {
      model,
      latencyMs: Date.now() - t0,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      costCents: usage?.costCents ?? 0,
    });
    return parseResponse(parsed, usage);
  }

  return {
    provider: "openai",
    model,
    async plan(messages, tools) {
      if (!apiKey) {
        throw Errors.internal(
          "OpenAI planner selected but OPENAI_API_KEY is not set. Set LLM_PROVIDER=mock or provide a key.",
        );
      }
      const t0 = Date.now();
      // Shared retry policy (blueprint §8.3): 3 retries, 1s/2s/4s backoff,
      // transient failures only. The plan is idempotent (read-only proposal).
      try {
        return await withRetry(() => planOnce(messages, tools), {
          label: `openai ${model}`,
          retryOn: isRetryable,
          onRetry: (attempt, delayMs, e) =>
            logger.warn("llm request retrying", {
              model,
              attempt,
              maxRetries: providerMaxRetries(),
              delayMs,
              error: errMsg(e),
            }),
        });
      } catch (lastErr) {
        logger.error("llm request failed", {
          model,
          attempts: providerMaxRetries() + 1,
          durationMs: Date.now() - t0,
          error: errMsg(lastErr),
        });
        if (lastErr instanceof LlmHttpError) throw Errors.tool(lastErr.message);
        const timedOut = lastErr instanceof Error && (lastErr.name === "TimeoutError" || lastErr.name === "AbortError");
        throw Errors.tool(timedOut ? "LLM request timed out." : "LLM request failed.");
      }
    },
  };
}
