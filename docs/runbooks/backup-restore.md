# Runbook — Backup & Disaster Recovery (blueprint §6.7)

**Targets: RTO ~1h, RPO ~15min** (blueprint §6.7).

## Managed Postgres (Supabase / Neon / RDS — recommended)

1. Enable daily automated snapshots (default on for most providers) **plus**
   PITR / WAL archiving; keep snapshot retention at **30 days** (§6.7).
2. Record the effective PITR window — RPO ≈ WAL-archival lag (typically
   1–15 min).
3. **Monthly restore drill** (blueprint §6.7: "test restore monthly"):
   - create a scratch instance/branch from the latest snapshot (or a PITR
     point 24h old);
   - point a staging app at it (`DATABASE_URL`), confirm `/health/ready` →
     200, log in, send one chat turn;
   - spot-check row counts (customers, orders, refunds) against production;
   - delete the scratch instance and record the drill outcome (issue
     tracker or `docs/incidents/`).
4. Secrets (`SESSION_SECRET`, provider keys) live in the platform secret
   store — keep them backed up/managed there; never in the image or repo.

## Self-hosted Postgres

```sh
# nightly pg_dump (cron 02:30), custom format + off-box storage
pg_dump -Fc "$DATABASE_URL" > /backups/aurora-$(date +%F).dump
# 30-day retention
find /backups -name 'aurora-*.dump' -mtime +30 -delete
# ship off-box (S3 or a second host)
aws s3 cp "/backups/aurora-$(date +%F).dump" s3://aurora-backups/
```

- **Quarterly restore test** (blueprint §6.7): stand up a scratch Postgres,
  `pg_restore` the latest dump, then run the same verification as step 3
  above (health + login + one chat turn + row-count spot check).

## Full DR (lost database instance)

1. Restore the latest snapshot/dump into a fresh instance (or PITR point if
   you need the last minutes of data).
2. Update `DATABASE_URL` in the secret store; redeploy/restart the app.
3. Migrations apply automatically at container boot (entrypoint gate).
4. Run the [post-deploy smoke test](./deploy.md#post-deploy-smoke-test-blueprint-115);
   check the audit log for any `refund.pending` backlog and settle it via
   the admin console (refunds are the source-of-truth money path).
5. Write the post-incident note: data-loss window, root cause, follow-ups.
