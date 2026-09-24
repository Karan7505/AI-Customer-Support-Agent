import { describe, it, expect } from "vitest";
import { createOpenAiLlm } from "@/lib/openai";

/**
 * LIVE provider test (blueprint §5.1) — runs only when a real key is set:
 *
 *   OPENAI_API_KEY=sk-... npm run test:live -- openai
 *
 * It is skipped in normal `npm test` / CI runs (no key => describe is skipped),
 * so the offline suite stays zero-config.
 */
describe.skipIf(!process.env.OPENAI_API_KEY)("live OpenAI provider", () => {
  it("completes a chat turn and reports usage", async () => {
    const llm = createOpenAiLlm();
    const plan = await llm.plan(
      [{ role: "user", content: "Reply with exactly the word: PONG" }],
      [],
    );
    expect(plan).toBeTruthy();
    if (plan.kind === "final") {
      expect(plan.text.length).toBeGreaterThan(0);
      expect(plan.usage).toMatchObject({ inputTokens: expect.any(Number) });
    }
  }, 60_000);
});
