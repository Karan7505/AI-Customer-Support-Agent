import { beforeEach } from "vitest";
import { resetLlmDailyCostsForTesting, resetRateLimits } from "@/lib/rate-limit";
import { resetSentEmailsForTesting } from "@/lib/notify";

// Deterministic env for all unit/integration tests. No real DB file, no keys.
process.env.LLM_PROVIDER = "mock";
process.env.AGENT_MAX_ITERATIONS = "6";
process.env.SESSION_SECRET = "test-secret";
process.env.APPROVAL_TTL_HOURS = "72";
// Ensure any accidental file access resolves inside the sandbox.
process.env.DATABASE_PATH = ":memory:";

// Reliability state is module-level (process-wide): rate-limit buckets, the
// LLM daily spend ledger, and the sent-email idempotency set. Reset between
// tests so files stay deterministic regardless of call order.
beforeEach(() => {
  resetRateLimits();
  resetLlmDailyCostsForTesting();
  resetSentEmailsForTesting();
});
