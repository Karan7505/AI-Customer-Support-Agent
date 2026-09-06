import type { LlmClient, LlmMessage, LlmPlan, LlmTool } from "./llm";
import { Errors } from "./errors";

/**
 * Real OpenAI-compatible function-calling planner. Uses global fetch (no SDK).
 * The model only PROPOSES a tool or a final message; the agent loop enforces
 * validation, authorization, risk, approval, and idempotency.
 */
export class OpenAiLlmClient implements LlmClient {
  readonly provider = "openai" as const;
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  }

  async plan(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmPlan> {
    if (!this.apiKey) {
      throw Errors.internal(
        "OpenAI planner selected but OPENAI_API_KEY is not set. Set LLM_PROVIDER=mock or provide a key.",
      );
    }
    const body = {
      model: this.model,
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
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw Errors.tool(`LLM request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      throw Errors.tool(`LLM request failed with HTTP ${res.status}.`);
    }
    const parsed = await res.json();
    return this.parseResponse(parsed);
  }

  private parseResponse(parsed: any): LlmPlan {
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
      return { kind: "tool", tool: tc.function.name, args, toolCallId: tc.id };
    }
    if (typeof choice.content === "string" && choice.content.trim()) {
      return { kind: "final", text: choice.content };
    }
    return {
      kind: "final",
      text: "I'm sorry, I couldn't complete that. Could you try rephrasing?",
    };
  }
}

export function createOpenAiLlm(): LlmClient {
  return new OpenAiLlmClient();
}
