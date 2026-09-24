import type { Repo } from "@/db/repos";
import type { Principal } from "./types";
import { nowMs } from "./util";
import { recordAuditWrite } from "./metrics";

/**
 * Audit logging. Every significant action produces an entry that lets you
 * reconstruct: who, what, authorized?, approved?, executed?, succeeded?
 * We never store secrets; only redacted arguments/results.
 */

const SECRET_KEYS = new Set([
  "password",
  "passwordhash",
  "secret",
  "apikey",
  "token",
  "authorization",
  "sessiontoken",
]);

function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return value.length > 4000 ? value.slice(0, 4000) + "…" : value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k.toLowerCase())) out[k] = "[redacted]";
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

export interface AuditContext {
  actor: Principal;
  conversationId?: string | null;
  approvalId?: string | null;
}

export function createAuditor(repo: Repo) {
  return {
    async log(
      ctx: AuditContext,
      action: string,
      opts: {
        toolName?: string | null;
        arguments?: unknown;
        result?: unknown;
        /** Observability (blueprint §10.4): outcome of the audited operation. */
        status?: "success" | "failure";
        /** Duration of the audited operation, in milliseconds. */
        durationMs?: number;
        /** Free-form JSON context (provider ids, iteration counts, ...). */
        metadata?: unknown;
      } = {},
    ) {
      const t0 = nowMs();
      await repo.addAudit({
        actorId: ctx.actor.id,
        actorRole: ctx.actor.role,
        action,
        toolName: opts.toolName ?? null,
        arguments: opts.arguments === undefined ? undefined : redact(opts.arguments),
        result: opts.result === undefined ? undefined : redact(opts.result),
        status: opts.status ?? null,
        durationMs: opts.durationMs ?? null,
        metadata: opts.metadata === undefined ? undefined : redact(opts.metadata),
        approvalId: ctx.approvalId ?? null,
        conversationId: ctx.conversationId ?? null,
        timestamp: nowMs(),
      });
      recordAuditWrite(nowMs() - t0);
    },
  };
}

export type Auditor = ReturnType<typeof createAuditor>;
