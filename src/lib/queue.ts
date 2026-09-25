import { genId } from "./ids";
import { nowMs } from "./util";
import { logger } from "./logger";
import { jobMaxRetries, jobRetryBackoffMs, queueProvider } from "./env";
import { createAuditor, type Auditor } from "./audit";
import type { Principal } from "./types";
import { getRepo, type Repo } from "@/db/repos";

/**
 * Background job queue (blueprint §5.6).
 *
 * Async work that must not block a request (email notifications, payment-provider
 * refund retries) is enqueued here and processed with retries and backoff.
 *
 * Providers:
 *  - "memory" (default, dev/MVP): in-process queue, persisted for the process
 *    lifetime only. Jobs that matter across restarts (provider refunds) are also
 *    recoverable from DB state: a refund stuck in `pending_execution` is retried
 *    the next time its approval is touched, so a lost in-memory queue degrades
 *    to "retry on next touch", not "lost forever".
 *  - "redis": extension point for production (Bull/BullMQ). Not bundled — see
 *    README "Background jobs" for the provider contract to implement.
 *
 * Job outcomes are audit-logged (job.completed / job.retried / job.failed)
 * under the `system` principal.
 */

export const JOB_TYPES = [
  "send_email_notification",
  "execute_refund_fallback",
  "escalate_ticket",
  /** Monthly DB↔Stripe reconciliation (blueprint §8.5). */
  "check_stripe_consistency",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface Job {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  /** Optional dedupe key: while a job with this key is queued/running, re-enqueue is a no-op. */
  dedupeKey: string | null;
  attempts: number;
  maxAttempts: number;
  nextRunAt: number;
  createdAt: number;
  status: "queued" | "running" | "completed" | "failed";
}

export interface JobContext {
  repo: Repo;
  auditor: Auditor;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<void>;

export interface JobQueue {
  readonly kind: string;
  registerHandler: (type: JobType, handler: JobHandler) => void;
  /** Returns the job id, or null when a duplicate (same dedupeKey) is already in flight. */
  enqueue: (type: JobType, payload: Record<string, unknown>, dedupeKey?: string) => Promise<string | null>;
  start: () => void;
  stop: () => void;
  /** Process all due jobs right now (the worker loop calls this; tests call it directly). */
  processNow: () => Promise<void>;
  size: () => number;
}

export const SYSTEM_ACTOR: Principal = {
  id: "system",
  role: "system",
  name: "System",
  email: "system@local",
};

/** Exponential backoff: base * 2^(retry-1)  (1s, 2s, 4s with defaults). */
function retryDelayMs(retryNumber: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** (retryNumber - 1), 60_000);
}

export function createMemoryJobQueue(opts: { ctx?: () => JobContext | Promise<JobContext> } = {}): JobQueue {
  const jobs = new Map<string, Job>();
  const handlers = new Map<JobType, JobHandler>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let processing = false;

  const ctx = opts.ctx ?? (async () => {
    const repo = getRepo();
    return { repo, auditor: createAuditor(repo) };
  });

  async function audit(action: string, job: Job, extra: Record<string, unknown> = {}, status: "success" | "failure" = "success", durationMs?: number) {
    try {
      const c = await ctx();
      await c.auditor.log({ actor: SYSTEM_ACTOR }, action, {
        toolName: job.type,
        arguments: job.payload,
        result: extra,
        status,
        durationMs,
        metadata: { jobId: job.id, type: job.type, attempts: job.attempts, ...extra },
      });
    } catch {
      logger.warn("job audit write failed", { jobId: job.id, action });
    }
  }

  const queue: JobQueue = {
    kind: "memory",

    registerHandler(type, handler) {
      handlers.set(type, handler);
    },

    async enqueue(type, payload, dedupeKey) {
      if (dedupeKey) {
        for (const j of jobs.values()) {
          if (j.dedupeKey === dedupeKey && (j.status === "queued" || j.status === "running")) {
            logger.debug("job enqueue deduped", { type, dedupeKey, existing: j.id });
            return null;
          }
        }
      }
      const job: Job = {
        id: genId("JOB"),
        type,
        payload,
        dedupeKey: dedupeKey ?? null,
        attempts: 0,
        maxAttempts: jobMaxRetries(),
        nextRunAt: nowMs(),
        createdAt: nowMs(),
        status: "queued",
      };
      jobs.set(job.id, job);
      logger.debug("job enqueued", { type, jobId: job.id });
      return job.id;
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        queue.processNow().catch((e) => logger.error("queue worker error", { error: e instanceof Error ? e.message : String(e) }));
      }, 100);
      // Never keep the process alive on our own.
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },

    size() {
      let n = 0;
      for (const j of jobs.values()) if (j.status === "queued" || j.status === "running") n++;
      return n;
    },

    async processNow() {
      if (processing) return;
      processing = true;
      try {
        const now = nowMs();
        for (const job of jobs.values()) {
          if (job.status !== "queued" || job.nextRunAt > now) continue;
          const handler = handlers.get(job.type);
          job.status = "running";
          job.attempts += 1;
          const t0 = nowMs();
          if (!handler) {
            job.status = "failed";
            logger.error("job handler missing", { type: job.type, jobId: job.id });
            await audit("job.failed", job, { error: "no handler registered" }, "failure");
            continue;
          }
          try {
            await handler(job, await ctx());
            job.status = "completed";
            logger.info("job completed", { type: job.type, jobId: job.id, attempts: job.attempts, durationMs: nowMs() - t0 });
            await audit("job.completed", job, { durationMs: nowMs() - t0 }, "success", nowMs() - t0);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (job.attempts >= job.maxAttempts) {
              job.status = "failed";
              logger.error("job failed after max attempts", { type: job.type, jobId: job.id, attempts: job.attempts, error: message });
              await audit("job.failed", job, { error: message }, "failure", nowMs() - t0);
            } else {
              const delay = retryDelayMs(job.attempts, jobRetryBackoffMs());
              job.nextRunAt = nowMs() + delay;
              job.status = "queued";
              logger.warn("job retry scheduled", { type: job.type, jobId: job.id, attempt: job.attempts, delayMs: delay, error: message });
              await audit("job.retried", job, { error: message, nextRetryInMs: delay });
            }
          }
        }
      } finally {
        processing = false;
      }
    },
  };
  return queue;
}

let defaultQueue: JobQueue | undefined;

/**
 * Process-wide default queue. Created on first use (never at module load, so
 * importing this file has no side effects in tests).
 */
export function getJobQueue(): JobQueue {
  if (!defaultQueue) {
    if (queueProvider() === "redis") {
      // Production extension point: implement a BullMQ-backed JobQueue and return it here.
      throw new Error(
        "QUEUE_PROVIDER=redis is a documented extension point (see README 'Background jobs'); " +
          "set QUEUE_PROVIDER=memory (the default) until a Redis-backed implementation is added.",
      );
    }
    defaultQueue = createMemoryJobQueue();
    defaultQueue.start();
  }
  return defaultQueue;
}

/** Test hook: replace the default queue instance (e.g. to inject a fresh memory queue). */
export function setJobQueueForTesting(q: JobQueue | undefined): void {
  defaultQueue = q;
}
