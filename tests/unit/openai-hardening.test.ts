import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createOpenAiLlm, estimateCostCents } from "@/lib/openai";
import { createLlmClient } from "@/lib/llm-factory";

const MESSAGES = [{ role: "user" as const, content: "hi" }];
const TOOLS: any[] = [];

function okResponse(plan: { content?: string; tool?: string; args?: Record<string, unknown>; usage?: { prompt_tokens: number; completion_tokens: number } }): Response {
  const message: any = {};
  if (plan.tool) {
    message.tool_calls = [{ id: "call_1", function: { name: plan.tool, arguments: JSON.stringify(plan.args ?? {}) } }];
  } else {
    message.content = plan.content ?? "Hello!";
  }
  return new Response(
    JSON.stringify({ choices: [{ message }], ...(plan.usage ? { usage: plan.usage } : {}) }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("OpenAI provider hardening (blueprint §5.1)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const llm = () => createOpenAiLlm({ apiKey: "sk-test", baseUrl: "http://fake.local/v1", model: "gpt-4o-mini" });

  it("retries transient 429 errors with backoff, then succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(okResponse({ content: "recovered" }));

    const plan = await llm().plan(MESSAGES, TOOLS);
    expect(plan.kind).toBe("final");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry non-transient 401 auth errors", async () => {
    fetchSpy.mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(llm().plan(MESSAGES, TOOLS)).rejects.toThrow(/HTTP 401/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fails after 3 retries when the provider keeps returning 5xx", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 503 }));
    await expect(llm().plan(MESSAGES, TOOLS)).rejects.toThrow(/HTTP 503/);
    expect(fetchSpy).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("surfaces token usage + estimated cost on the plan", async () => {
    fetchSpy.mockResolvedValue(
      okResponse({ content: "ok", usage: { prompt_tokens: 1000, completion_tokens: 500 } }),
    );
    const plan = await llm().plan(MESSAGES, TOOLS);
    expect(plan.usage).toMatchObject({ inputTokens: 1000, outputTokens: 500 });
    // gpt-4o-mini: $0.15/1M in, $0.60/1M out => 0.015 + 0.03 = 0.045 cents, rounded to 2dp => 0.05
    expect(plan.usage?.costCents).toBe(0.05);
  });

  it("estimates cost per model (unknown models cost 0)", () => {
    expect(estimateCostCents("gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(75, 5);
    expect(estimateCostCents("unknown-model", 1_000_000, 1_000_000)).toBe(0);
  });

  it("falls back to the mock planner when the provider is down (factory)", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_BASE_URL", "http://fake.local/v1");
    fetchSpy.mockResolvedValue(new Response("down", { status: 401 }));

    const client = createLlmClient();
    expect(client.provider).toBe("openai");
    // 401 is non-retryable -> single call -> fallback to mock (no throw).
    const plan = await client.plan(MESSAGES, TOOLS);
    expect(plan).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
