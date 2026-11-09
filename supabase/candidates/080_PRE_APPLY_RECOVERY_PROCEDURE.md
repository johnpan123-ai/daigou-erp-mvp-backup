# 080 — pre-apply procedure (candidate; nothing here has been run on production)

Deadlock: the release guard needs a fresh authoritative 24-resource JSON, but the export RPC fails
(HTTP 500 / 57014, ~10.36 s). Not acceptable substitutes: the 2026-11-05 backup, the 16-resource Workbench
export, or calling the RPC from SQL Editor with forged JWT claims (withdrawn "Method A").

## Step 1 — read-only root-cause evidence (as postgres, SQL Editor or psql direct connection)
Run `080_readonly_root_cause_diagnostics.sql`. Read-only transaction, rolled back, no RPC, no impersonation.
Accept 080 only if BOTH hold:
- A1/A2 show a statement_timeout on `authenticated` (or `authenticator`/database) below the export time; and
- B shows Execution Time above that limit but well below 60 s (080 ceiling).
Otherwise STOP (e.g. limit not found -> API gateway/other layer; time >= 60 s -> transport redesign).
Also check Dashboard > Logs > Postgres for "canceling statement due to statement timeout" from user
`authenticator` at the failing timestamp; and the PostgREST version (hoisting of function-level
statement_timeout requires PostgREST >= 12; isolated proof used 13.0.7).

## Step 2 — recovery guarantee (one of)
A. Platform recovery point (Dashboard > Database > Backups / PITR), later than the last business write.
B. Consistent read-only pg_dump, preferred variant without any permission change:
   `PGOPTIONS='-c default_transaction_read_only=on' pg_dump --format=custom --schema=public --no-owner --serializable-deferrable -f erp2-pre080.dump "<direct URI, user postgres>"`
   Only if postgres cannot be used: `080_pgdump_readonly_role_candidate.sql` (SELECT + BYPASSRLS, NOLOGIN until
   time-boxed activation), then `080_pgdump_readonly_role_revoke.sql` immediately after the dump.
   Record sha256, pg_dump version (must be >= server major), time.

## Step 3 — single-use approval record bound to this change
{ project: rhfdjsklfrgpoqsaqpkn, migration: 080_backup_export_function_timeout_single_flight.sql,
  sql_sha256: <SHA256SUMS>, recovery: <A|B evidence>, root_cause: <Step 1 values>, approved_by: Owner,
  approved_at, expires: same day }. Release tool accepts it only for this exact sha256 and only when the
migration touches `public.erp_export_cloud_restore_snapshot_json` alone; any mismatch FAILS CLOSED. No reusable exemption.

## Step 4 — apply and restore the normal path
Apply 080 (contains `notify pgrst, 'reload schema'`; PostgREST reads function settings at schema-cache load).
Immediately run in-app 「匯出 JSON 備份」: must finish without 57014 and pass manifest/24-resource checks;
that file is the normal guard input from then on. Rollback: `080_rollback.sql` (function only).
