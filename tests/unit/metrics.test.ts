import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import client from "prom-client";
import {
  recordHttpRequest,
  recordLlmCall,
  recordDbQuery,
  approvalQueueLength,
  ensureMetricsServer,
  metricsServerPort,
  stopMetricsServer,
  httpRequestsTotal,
  llmRequestsTotal,
} from "@/lib/metrics";

afterEach(() => {
  vi.unstubAllEnvs();
  stopMetricsServer();
});

async function counterValue(name: string, labels: Record<string, string>): Promise<number | undefined> {
  const metrics = await client.register.getMetricsAsJSON();
  const m = metrics.find((x) => x.name === name);
  if (!m) return undefined;
  const v = m.values.find((x) => Object.keys(labels).every((k) => x.labels[k] === labels[k]));
  return v?.value;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

describe("Prometheus metrics (blueprint §10.2)", () => {
  it("records HTTP requests with method/path/status labels", async () => {
    httpRequestsTotal.reset();
    recordHttpRequest("POST", "/api/chat", 200, 123);
    recordHttpRequest("POST", "/api/chat", 500, 45);
    expect(await counterValue("http_requests_total", { method: "POST", path: "/api/chat", status: "200" })).toBe(1);
    expect(await counterValue("http_requests_total", { method: "POST", path: "/api/chat", status: "500" })).toBe(1);
  });

  it("records LLM calls, DB query durations and approval gauges", async () => {
    llmRequestsTotal.reset();
    recordLlmCall("mock", "success", 12);
    expect(await counterValue("llm_requests_total", { model: "mock", status: "success" })).toBe(1);

    recordDbQuery("applyRefund", 5);
    const metrics = await client.register.getMetricsAsJSON();
    const hist = metrics.find((x) => x.name === "database_query_duration_seconds");
    const sum = hist?.values.find(
      (v) => (v as { metricName?: string }).metricName === "database_query_duration_seconds_sum" && v.labels.operation === "applyRefund",
    );
    expect(sum?.value).toBeCloseTo(0.005);

    approvalQueueLength.set(3);
    const after = await client.register.getMetricsAsJSON();
    expect(after.find((x) => x.name === "approval_queue_length")?.values[0].value).toBe(3);
    approvalQueueLength.set(0);
  });

  it("serves /metrics on a localhost port and 404s elsewhere", async () => {
    const port = await freePort();
    vi.stubEnv("METRICS_PORT", String(port));
    ensureMetricsServer();
    for (let i = 0; i < 50 && metricsServerPort() !== port; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(metricsServerPort()).toBe(port);

    const get = (p: string) =>
      new Promise<{ code: number; body: string }>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: p }, (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => resolve({ code: res.statusCode ?? 0, body: b }));
          })
          .on("error", reject);
      });

    const ok = await get("/metrics");
    expect(ok.code).toBe(200);
    expect(ok.body).toContain("http_requests_total");
    expect((ok.body.match(/http_request_duration_seconds_bucket/g) ?? []).length).toBeGreaterThan(0);

    const nf = await get("/nope");
    expect(nf.code).toBe(404);
  });

  it("does not start when METRICS_ENABLED=false", async () => {
    vi.stubEnv("METRICS_ENABLED", "false");
    ensureMetricsServer();
    expect(metricsServerPort()).toBeUndefined();
  });
});
