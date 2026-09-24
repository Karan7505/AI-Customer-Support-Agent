/**
 * Boot-time safety checks (Next.js instrumentation hook).
 * Runs once per process for the Node runtime — before the server accepts
 * traffic — and refuses to boot a production deployment with unsafe defaults
 * (missing SESSION_SECRET). See assertProductionReady in src/lib/env.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertProductionReady } = await import("@/lib/env");
    assertProductionReady();
  }
}
