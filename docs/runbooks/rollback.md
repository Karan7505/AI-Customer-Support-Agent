# Runbook — Rollback (blueprint §11.5)

**Key property:** schema migrations are **append-only** (new nullable
columns, new tables, new indexes — never drop/rename). A previous image is
therefore compatible with a forward-migrated schema, so rolling back the
IMAGE never requires touching the schema.

## Procedure

1. Point the platform at the previous known-good image tag (or, on
   source-deploy platforms, `git revert` the release commit and redeploy).
2. Wait for `/health/live` + `/health/ready` → 200 (`db: true`).
3. Run the [post-deploy smoke test](./deploy.md#post-deploy-smoke-test-blueprint-115).
4. If the rollback itself is unhealthy: stop the service (the platform's
   health check drains it) and escalate per [incident-response.md](./incident-response.md).

## Never

- Do NOT write a "down" migration that drops/renames columns to make a
  rollback easier — schema changes are append-only (blueprint §6.2);
  old-image compatibility depends on it.
- Do NOT roll back past the migration that introduced a column the old image
  reads — if a migration was destructive by accident, recover the data from
  backup (see the backup/DR docs) instead.
