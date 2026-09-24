import client from "prom-client";
import { logger } from "./logger";
import { metricsEnabled, metricsPort } from "./env";

/**
 * Prometheus metrics (blueprint §10.2).
 *
 * The exporter listens on a localhost-only port (METRICS_PORT, default 9090)
 * so it is internal-only even on a misconfigured host. Metrics are created on
 * the prom-client GLOBAL registry; every recording call is exception-safe —
 * metrics must never break a request.
 *
 * NOTE: this module imports prom-client, whose top level requires http/zlib
 * (pushgateway) — it must therefore only be imported from nodejs-runtime
 * code (routes / lib), never from src/instrumentation.ts (edge graph).
 * The server starts on first API request (see ensureMetricsServer) rather
 * than at boot for the same reason.
 */

const B = {
  http: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  llm: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  db: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
};

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "HTTP requests by method, path, and status.",
  labelNames: ["method", "path", "status"],
});

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration by method and path.",
  labelNames: ["method", "path"],
  buckets: B.http,
});

export const llmRequestsTotal = new client.Counter({
  name: "llm_requests_total",
  help: "LLM planner calls by model and outcome (success|error|fallback).",
  labelNames: ["model", "status"],
});

export const llmRequestDuration = new client.Histogram({
  name: "llm_request_duration_seconds",
  help: "LLM planner call duration by model.",
  labelNames: ["model"],
  buckets: B.llm,
});

export const dbQueryDuration = new client.Histogram({
  name: "database_query_duration_seconds",
  help: "Notable database operation duration by operation.",
  labelNames: ["operation"],
  buckets: B.db,
});

export const chatRequestsTotal = new client.Counter({
  name: "chat_requests_total",
  help: "Chat (agent turn) outcomes.",
  labelNames: ["result"],
});

export const refundRequestsTotal = new client.Counter({
  name: "refund_requests_total",
  help: "Refund executions by outcome (completed|failed|existing).",
  labelNames: ["status"],
});

export const approvalRequestsTotal = new client.Counter({
  name: "approval_requests_total",
  help: "Approval requests by outcome (created|reused).",
  labelNames: ["outcome"],
});

export const approvalDecisionsTotal = new client.Counter({
  name: "approval_decisions_total",
  help: "Approval decisions by outcome (approved|rejected).",
  labelNames: ["decision"],
});

export const approvalQueueLength = new client.Gauge({
  name: "approval_queue_length",
  help: "Pending approval requests currently in the queue.",
});

export const auditWriteDuration = new client.Histogram({
  name: "audit_write_duration_seconds",
  help: "Audit log write duration.",
  buckets: B.db,
});

/* ----------------------------- record helpers ---------------------------- */

export function recordHttpRequest(method: string, path: string, status: number, durationMs: number): void {
  try {
    httpRequestsTotal.inc({ method, path, status: String(status) });
    httpRequestDuration.observe({ method, path }, durationMs / 1000);
  } catch {
    /* never break the request */
  }
}

export function recordLlmCall(model: string, status: "success" | "error" | "fallback", durationMs: number): void {
  try {
    llmRequestsTotal.inc({ model, status });
    llmRequestDuration.observe({ model }, durationMs / 1000);
  } catch {
    /* never break the request */
  }
}

export function recordDbQuery(operation: string, durationMs: number): void {
  try {
    dbQueryDuration.observe({ operation }, durationMs / 1000);
  } catch {
    /* never break the request */
  }
}

export function recordAuditWrite(durationMs: number): void {
  try {
    auditWriteDuration.observe(durationMs / 1000);
  } catch {
    /* never break the request */
  }
}

/* ----------------------------- metrics server ---------------------------- */

let server: { port: number } | undefined;
let httpServer: import("node:http").Server | undefined;
let starting = false;

/**
 * Start the localhost-only /metrics server (idempotent, best-effort).
 * Called from the API request wrapper (first request) because this module
 * cannot live in the edge-compiled instrumentation graph.
 */
export function ensureMetricsServer(): void {
  if (server || starting || !metricsEnabled()) return;
  starting = true;
  const getter = (
    process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule;
  const http = getter?.("node:http") as typeof import("node:http") | undefined;
  if (!http) {
    starting = false;
    return;
  }
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/metrics" || req.url === "/")) {
      client.register
        .metrics()
        .then((text) => {
          res.writeHead(200, { "Content-Type": client.register.contentType });
          res.end(text);
        })
        .catch((e) => {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(String(e));
        });
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  srv.once("error", (e) => {
    starting = false;
    logger.warn("metrics server failed to start", { port: metricsPort(), error: e });
  });
  httpServer = srv;
  srv.listen(metricsPort(), "127.0.0.1", () => {
    const addr = srv.address();
    server = { port: addr && typeof addr === "object" ? addr.port : metricsPort() };
    logger.info("metrics server listening", { port: server.port, path: "/metrics" });
  });
}

/** Actual bound port, once the server is up (undefined before). */
export function metricsServerPort(): number | undefined {
  return server?.port;
}

/** Stop the server (tests / clean shutdown). */
export function stopMetricsServer(): void {
  httpServer?.close();
  httpServer = undefined;
  server = undefined;
  starting = false;
}
