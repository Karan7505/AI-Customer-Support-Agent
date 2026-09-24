import { describe, it, expect, vi, afterEach } from "vitest";
import { readinessCheck, clearReadinessCache } from "@/lib/health";
import { GET as liveGET } from "@/app/health/live/route";
import { GET as readyGET } from "@/app/health/ready/route";

afterEach(() => {
  clearReadinessCache();
  vi.unstubAllEnvs();
});

describe("Health endpoints (blueprint §10.3)", () => {
  it("GET /health/live returns 200 {status:ok} with a correlation header", async () => {
    const res = await liveGET(new Request("http://localhost/health/live"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("GET /health/ready returns 200 when the database is reachable", async () => {
    const res = await readyGET(new Request("http://localhost/health/ready"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean; dependencies: { db: { status: string } } };
    expect(body.ready).toBe(true);
    expect(body.dependencies.db.status).toBe("ok");
  });

  it("GET /health/ready returns 503 when the database is down", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://u:p@127.0.0.1:59998/db");
    const res = await readyGET(new Request("http://localhost/health/ready"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean; dependencies: { db: { status: string } } };
    expect(body.ready).toBe(false);
    expect(body.dependencies.db.status).toBe("down");
  });

  it("caches readiness results for HEALTH_CHECK_INTERVAL_MS", async () => {
    const a = await readinessCheck();
    const b = await readinessCheck();
    expect(a.checkedAt).toBe(b.checkedAt);
    vi.stubEnv("HEALTH_CHECK_INTERVAL_MS", "0");
    const c = await readinessCheck();
    expect(c.checkedAt).toBeGreaterThanOrEqual(a.checkedAt);
    expect(c).not.toBe(a);
  });
});
