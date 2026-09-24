import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { createDb } from "@/db/client";
import { createSqliteRepo } from "@/db/repos";
import { createAuditor } from "@/lib/audit";
import { runSqliteMigrations } from "@/db/migration-runner";
import { parseJson } from "@/lib/util";
import { principal } from "../helpers";

describe("Audit enrichment (blueprint §10.4)", () => {
  it("persists metadata, status and durationMs on audit rows", async () => {
    const { db, raw } = createDb(":memory:");
    try {
      const repo = createSqliteRepo(db);
      const auditor = createAuditor(repo);
      await auditor.log({ actor: principal("CUST-1"), conversationId: null }, "test.action", {
        toolName: "process_refund",
        arguments: { orderId: "ORD-1" },
        result: { refundId: "REF-1" },
        status: "success",
        durationMs: 42,
        metadata: { iterationsUsed: 3, toolCalls: 2 },
      });
      const rows = await repo.listAudit({ limit: 5 });
      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect(r.status).toBe("success");
      expect(r.durationMs).toBe(42);
      expect(typeof r.metadata).toBe("string");
      expect(parseJson(r.metadata as string, null)).toEqual({ iterationsUsed: 3, toolCalls: 2 });
    } finally {
      raw.close();
    }
  });

  it("leaves the new fields null when not provided", async () => {
    const { db, raw } = createDb(":memory:");
    try {
      const repo = createSqliteRepo(db);
      await repo.addAudit({ actorId: "CUST-1", actorRole: "customer", action: "plain.action" });
      const rows = await repo.listAudit({ limit: 5 });
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toBeNull();
      expect(rows[0].status).toBeNull();
      expect(rows[0].durationMs).toBeNull();
    } finally {
      raw.close();
    }
  });

  it("redacts secrets inside metadata", async () => {
    const { db, raw } = createDb(":memory:");
    try {
      const repo = createSqliteRepo(db);
      const auditor = createAuditor(repo);
      await auditor.log({ actor: principal("CUST-1"), conversationId: null }, "test.action", {
        metadata: { apiKey: "sk-secret-value", note: "visible" },
      });
      const rows = await repo.listAudit({ limit: 5 });
      const meta = parseJson(rows[0].metadata as string, {}) as Record<string, unknown>;
      expect(meta.apiKey).toBe("[redacted]");
      expect(meta.note).toBe("visible");
    } finally {
      raw.close();
    }
  });

  it("applies the 002 columns to a pre-enrichment (legacy) database", () => {
    const raw = new Database(":memory:");
    try {
      raw.exec(
        "CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, tool_name TEXT, arguments TEXT, result TEXT, approval_id TEXT, conversation_id TEXT, timestamp INTEGER NOT NULL)",
      );
      runSqliteMigrations(raw);
      const cols = (raw.prepare("PRAGMA table_info(audit_logs)").all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain("metadata");
      expect(cols).toContain("status");
      expect(cols).toContain("duration_ms");
    } finally {
      raw.close();
    }
  });
});
