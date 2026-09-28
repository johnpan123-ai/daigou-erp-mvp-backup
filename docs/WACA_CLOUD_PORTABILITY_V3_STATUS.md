# WACA Cloud portability v3 — source handoff (2026-09-28)

This is a source-only candidate, not an authorization to apply SQL or deploy.
The current Cloud Restore database contract is 24 tables (previously 15), plus
the Deadline Lookup browser sidecar section. The JSON backup format is v2.

## Implemented and isolated-verified

- `044_waca_cloud_ledger.sql`: owner-scoped RLS/Data API, seven WACA tables,
  atomic import/upsert/recompute/CAS, legacy 8 → order-derived 11 without adding.
- `045_waca_cloud_atomic_restore_closure.sql`: extends the current Restore
  snapshot, manifest, proof, writer, integrity, rollback, and portability
  functions to 24 tables. The 041–043 dispatch source is unchanged; Execute
  remains 269 bytes in the client regression.
- `046_waca_myacg_parent_evidence.sql`: persists BuyAnime GP parent evidence
  through the existing field-CAS gateway.
- Local and Cloud JSON format classification, legacy cutover state, modern WACA
  ledger restore, and the three durable Deadline Lookup sidecar stores.
- Disposable PostgreSQL 18 and PostgREST 16.4 tests cover owner/anon/non-owner
  access, five repeated imports, four injected import failures, 24-table
  restore rollback, and denied direct writer access.

## Remaining gates before claiming full closure

1. `dashboard_category_images` metadata is in the 24-table JSON snapshot, but
   image bytes in the separate `dashboard-category-images` Storage bucket are
   not embedded. Same-project restore retains existing objects; cross-project
   restore of a row with `storage_path` is not proven portable. Inventory the
   bucket in the authorized target and define/test an asset backup/restore
   policy before declaring all durable Cloud data covered.
2. The isolated test installs the Restore-specific chain
   023–026/028/030/035–043 and 044–046. Historical 027 and 029 require an
   id-only inventory primary key, while canonical 028 requires
   `inventory_key`; they are superseded transition artifacts, not a sequential
   fresh-install list. A separately maintained canonical fresh/reset chain is
   still needed before `fresh/reset compatible` can be marked PASS.
3. No Staging or Live SQL apply, Cloudflare deploy, Live Restore, or live
   business write was performed in this Sol turn. Post-apply Cloud postflight
   and live acceptance remain for a separately authorized Luna run.

Do not label this commit the v3 closure checkpoint until the first two gates
are resolved. New durable resources must be classified in
`durableResourceRegistry.ts` and covered by backup, restore, and portability
tests before promotion.
