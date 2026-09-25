# 033 Outbound Status Transition Timestamp Candidate

- Purpose: add a server-authored `status_changed_at timestamptz` to `outbound_shipments`, so “最近狀態變更” never treats unrelated `updated_at` edits as status transitions.
- Dependency: applied outbound table migration 017 and field-CAS path 020. It does not replace or modify applied 031/032.
- Write contract: a `BEFORE INSERT OR UPDATE OF status` trigger sets the timestamp. Non-status edits preserve the prior timestamp; clients cannot write this field through the field-CAS whitelist.
- Portability: PostgreSQL/Supabase catalog objects only; no project ref, user ID, Auth row, or environment-specific data.
- ACL: trigger helper is `SECURITY INVOKER`; execute is revoked from PUBLIC, anon, and authenticated. The trigger remains server-internal.
- Postflight: validates nullable timestamptz column, enabled trigger/function binding, function kind/security/search_path, and ACL.
- Recovery: if the unapplied candidate is rejected, no action is required. After an authorized apply, recovery is a separately reviewed migration that drops the trigger/index/column only after callers no longer read it; do not edit or roll back migration history in place.
- Historical rows: not backfilled from `updated_at`. They intentionally remain without a precise transition time and sort after rows with a server-recorded time.
