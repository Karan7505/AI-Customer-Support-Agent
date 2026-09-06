// Deterministic env for all unit/integration tests. No real DB file, no keys.
process.env.LLM_PROVIDER = "mock";
process.env.AGENT_MAX_ITERATIONS = "6";
process.env.SESSION_SECRET = "test-secret";
process.env.APPROVAL_TTL_HOURS = "72";
// Ensure any accidental file access resolves inside the sandbox.
process.env.DATABASE_PATH = ":memory:";
