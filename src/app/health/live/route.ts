import { json, apiRequest } from "../../api/_util";

export const runtime = "nodejs";

/**
 * GET /health/live - liveness probe: the process is up.
 * Deliberately checks nothing else (blueprint §10.3).
 */
export async function GET(req: Request) {
  return apiRequest(req, "GET", "/health/live", async () => json({ status: "ok" }));
}
