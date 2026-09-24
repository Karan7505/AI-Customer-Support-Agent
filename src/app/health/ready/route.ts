import { NextResponse } from "next/server";
import { apiRequest } from "../../api/_util";
import { readinessCheck } from "@/lib/health";

export const runtime = "nodejs";

/**
 * GET /health/ready - readiness probe: 200 when ready, 503 when the
 * database is unreachable. Dependency details are returned in the body
 * (results cached for HEALTH_CHECK_INTERVAL_MS, default 30s).
 */
export async function GET(req: Request) {
  return apiRequest(req, "GET", "/health/ready", async () => {
    const r = await readinessCheck();
    return NextResponse.json(r, { status: r.ready ? 200 : 503 });
  });
}
