# Runbook — Incident Response

## Severity

- **S1** — site down, or the money path broken (refund/Stripe) → page the
  owner immediately.
- **S2** — degraded but serving (LLM in mock fallback, email backlog, 5xx
  spike, provider outage) → fix within the day.
- **S3** — minor/cosmetic → normal queue.

## Triage (first 10 minutes)

1. `GET /health/live` + `GET /health/ready`.
   - `ready` → 503 `db: false` → **database incident**: check the Postgres
     service, `DATABASE_URL` secret, network/policy, disk.
   - `ready` 200 but errors in logs → app/provider incident, continue.
2. Structured logs: grep by `corr` (correlation id) for the failing request;
   look for `rate limit hit`, `provider request retrying`, `job.failed`,
   `refund.*`, `stripe.consistency_check`.
3. Audit log: recent `failure` entries by action
   (`refund.orphaned`, `refund.pending`, `job.failed`, `approval.*`).
4. Metrics: HTTP 5xx rate, LLM error/fallback counters, queue depth,
   refund status counts (`pending_execution` backlog = provider problem).

## Common scenarios

- **Provider 5xx storm (Stripe/OpenAI/EasyPost/Resend)** — retries absorb
  transient blips; fallbacks engage (LLM → mock with warning, EasyPost → mock
  tracking, Stripe → `pending_execution` queue, Resend → queue retries).
  Action: monitor; queues drain automatically. No user data is lost.
- **Stripe refund orphaned** (`refund.orphaned` audit from the monthly
  consistency check) — DB is the source of truth. Investigate the payment
  intent in Stripe **first** (the refund may exist under a different id).
  Never re-issue a refund from the app for an `orphaned` row without ops
  sign-off. See README → *Reliability & failure recovery*.
- **Email backlog / `job.failed`** — check `RESEND_API_KEY`, credits, and
  recipient lists. Emails are non-blocking: chat, tickets and refunds are
  unaffected; the backlog retries on the next job attempt.
- **429 spike** — verify the limits are intentional (`RATE_LIMIT_MSG_PER_HOUR`
  etc.). A burst of 429s from one IP/customer is usually abuse or a stuck
  client — do NOT raise limits to "fix" it; treat as a security signal.
- **Bad deploy** — rollback per [rollback.md](./rollback.md).
- **Credential compromise suspected** — rotate immediately (see the rotation
  section in README → *Commit guard & credential rotation*), then audit the
  `auth.*` entries.

## Close

- Record: what / when / impact / root cause / fix — a short post-incident
  note in the issue tracker or `docs/incidents/` (create on first use).
- Follow-ups (missing alert, missing test) become issues, not chat threads.
