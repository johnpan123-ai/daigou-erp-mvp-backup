# 080 — one-time pre-apply recovery assurance while the backup RPC is broken (candidate)

Deadlock: the release guard wants a fresh authoritative 24-resource JSON, but the RPC that produces it
times out (57014, ~10.36 s). Not acceptable as substitutes: the 2026-11-05 backup, the 16-resource
Workbench export, or calling the RPC from SQL Editor with forged JWT claims (not the ERP2 Owner auth path,
Dashboard timeout) — that earlier "Method A" is withdrawn.

## Why a one-time procedure is proportionate for 080 only
080 replaces one read-only function (no table, data, ACL, RLS, role, timeout or Ledger change) and has an
exact rollback file. The guard's backup requirement protects business data; 080 cannot change it.

## Step 1 — root-cause evidence (read only)
Run `080_readonly_root_cause_diagnostics.sql` (as postgres; SQL Editor or psql over the direct connection).
It executes the export's exact SELECT twice in a READ ONLY transaction (jit on / jit off) with
EXPLAIN (ANALYZE, BUFFERS, SETTINGS). No RPC call, no impersonation, nothing persisted.
Accept 080 only if the evidence shows the JIT share (or the jit-off timing) explains the 57014. Otherwise STOP
and re-evaluate (e.g. compute size / I/O).

## Step 2 — recovery guarantee (one of)
A. Platform recovery point: Supabase Dashboard > Database > Backups (daily backup or PITR) for project
   `rhfdjsklfrgpoqsaqpkn`, timestamp later than the last business write. Record ref + timestamp.
B. Consistent PostgreSQL snapshot: from the Owner's machine over the direct connection of that project,
   read-only session, single snapshot (pg_dump default):
   `PGOPTIONS='-c default_transaction_read_only=on' pg_dump --format=custom --schema=public --no-owner -f erp2-pre080.dump "<direct connection URI for rhfdjsklfrgpoqsaqpkn>"`
   Record host (contains the project ref), sha256 of the file, pg_dump version, time.
Either gives a complete recovery guarantee for the whole project. Neither is presented as the App's
authoritative JSON.

## Step 3 — single-use approval record (audit), bound to this change only
{ project: rhfdjsklfrgpoqsaqpkn, migration: 080_backup_export_jit_off_single_flight.sql,
  sql_sha256: <value in SHA256SUMS>, recovery: <A or B evidence>, root_cause: <Step 1 summary>,
  approved_by: Owner, approved_at, expires: same day }.
The release tool accepts it only for this exact SQL sha256 and only when the migration's statements touch
`public.erp_export_cloud_restore_snapshot_json` alone; any mismatch FAILS CLOSED. No reusable exemption.

## Step 4 — apply and restore the normal path
Apply 080. Immediately run the in-app 「匯出 JSON 備份」: it must complete without 57014 and pass the
manifest/24-resource checks. That file becomes the normal guard input for every later release.
Rollback if needed: `080_rollback.sql` (function only).
