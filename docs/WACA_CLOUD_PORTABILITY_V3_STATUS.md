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
- `supabase/canonicalFreshInstallV3.mjs` is the explicit empty-database source
  order. `tests/waca-fresh-install-chain-v3.mjs` installs the full product chain
  in an empty isolated PostgreSQL database, separately upgrades a populated
  043 baseline through 044–046, compares tables/columns/constraints/indexes/
  triggers/RLS/policies/function definitions and ACLs by SHA-256, then exports
  and atomically restores all 24 resources across those databases. The fresh
  import proves legacy 8 → order-derived 11, five replays without quantity
  accumulation, and non-owner RLS. No Supabase project is contacted.

## Current homepage image classification (rechecked at HEAD)

- `App.tsx` mounts `pages/Dashboard.tsx`; `Dashboard_backup.tsx` is not mounted.
  The current Dashboard has no image component, background image, image upload,
  or read of `dashboard_category_images`/`dashboardImageStore`. NEXT 4192
  `/dashboard` rendered no image elements, computed CSS images, or image
  controls at this HEAD.
- No current `src` or `functions` product path calls Supabase Storage for the
  historical `dashboard-category-images` bucket. The bucket and old migration
  sources are legacy artifacts. A bucket object is not required by the
  currently mounted ERP UI and is **not** a WACA Cloud Promotion blocker.
- The Cloud provider still reads `dashboard_category_images` during its
  full-pull sync and retains rows in JSON/Atomic Restore for old-data
  compatibility. This is an active metadata compatibility path, not an active
  image-display or Storage-binary feature. Do not remove the 24th table from
  the existing Restore contract as part of this classification correction.
- Both the compatibility-preserved metadata/local backup and the unused
  Storage-binary bucket are classified under `D_LEGACY_UNUSED` in the resource
  registry. Historical schema/bucket cleanup is a separate task.

## Fresh/reset route and historical alternatives

The SQL files predate an automatic migration directory: several are mutually
exclusive SQL Editor artifacts. The supported source order is the executable
manifest, not a filename glob. In particular, 014 establishes an
`inventory_key` primary key. New `026b_cloud_inventory_uuid_identity_bridge.sql`
preserves that business key, adds UUID `id` as the database identity, and
uniquely constrains `inventory_key`; it also accepts an already-upgraded
UUID-id table. Then 027 and 029 run against their required UUID-id contract.
The 028 schema-aware writer is the alternative for the older
`inventory_key`-PK branch, not a step to run after 027. Running 028 and 029
sequentially is a deterministic contract mismatch, not a recoverable warning.
The obsolete 002 draft is also excluded; new 018 defines its only still-needed
`import_batches` resource without reintroducing conflicting core tables.

The isolated test is a Supabase db-reset **equivalent for the product SQL
chain**, with minimal Supabase `auth`/`extensions` primitives and the actual
source migrations. It is not a claim that `supabase db reset` itself ran or that
Supabase Live has this exact historical state. Luna must inspect the target
project's applied migration history and schema before any separately
authorized apply.

No Staging or Live SQL apply, Cloudflare deploy, Live Restore, or live business
write was performed in this Sol turn. New active durable resources must be
classified in `durableResourceRegistry.ts` and covered by backup, restore, and
portability tests before promotion.
