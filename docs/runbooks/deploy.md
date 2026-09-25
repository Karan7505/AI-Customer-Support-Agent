# Runbook — Deployment (blueprint §11.5)

Deployment = build the Docker image, point the platform at it, verify health
+ a smoke test, then close. All environment values live in the platform's
secret store — never in the image.

## Preconditions (staging + production)

- `main` is green on the full gate: typecheck, lint, unit + integration
  (SQLite **and** Postgres), E2E, `npm audit --omit=dev`, production build,
  `docker build`.
- **DATABASE_URL** — Postgres 15+ (managed service or self-hosted), reachable
  from the platform. Migrations are applied automatically by the entrypoint.
- **SESSION_SECRET** — fresh, long, random (`openssl rand -hex 32`). Rotating
  it signs out all sessions (expected).
- Provider keys per enabled integration: `OPENAI_API_KEY`,
  `STRIPE_SECRET_KEY` (test mode until sign-off), `EASYPOST_API_KEY`,
  `RESEND_API_KEY` + `ADMIN_EMAIL_LIST` / `SUPPORT_TEAM_EMAIL_LIST` /
  `NOTIFICATIONS_FROM`. Everything else has safe defaults (.env.example).

## Build

```sh
docker build -t aurora-support:<tag> .
```

## Deploy (Render / Railway / ECS — any Docker platform)

1. Push the image to the registry (owner action) or enable build-on-platform.
2. Create/update the service with image `aurora-support:<tag>` and the env
   vars from the secret store.
3. The container self-validates: entrypoint runs `node migrate.mjs`
   (migrations, fail → exit 1), then the boot gate checks env, then
   `server.js` starts. Any failure = unhealthy instance, zero traffic.
4. Wait until `/health/live` **and** `/health/ready` return 200
   (`ready` body reports `db: true`).

## Post-deploy smoke test (blueprint §11.5)

1. `GET /health/live` → 200; `GET /health/ready` → 200 with `db: true`
2. Log in as a customer, send one chat message (verify the reply path —
   mock or live LLM)
3. Ask the agent to create a support ticket; verify the ticket appears and
   the notification job completes (audit `job.completed`)
4. Approve a **test-mode** refund in the admin dashboard; verify Stripe
   (dashboard) + DB (`refund.completed` audit)
5. Check metrics/logs: no 5xx spike, no `llm` error burst, queue empty

## Rollback

See [rollback.md](./rollback.md).
