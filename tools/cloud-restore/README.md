# Cloud Mode JSON Atomic Restore

This experimental path replaces Cloud authoritative data only through
`public.erp_restore_cloud_snapshot`. The browser performs parsing and preflight,
but PostgreSQL owns the maintenance lock, rollback snapshot, idempotency claim,
resource replacement, integrity readback, and commit/rollback decision.

## Resource matrix

| JSON collection | PostgreSQL table | Identity | Relationship checks |
| --- | --- | --- | --- |
| inventory | inventory_items | inventory_key | N/A |
| productGroups | product_groups | canonical UUID | N/A |
| productCategories | product_categories | canonical UUID | product_group_id |
| productVariants | product_variants | canonical UUID; local_id metadata only | group/category |
| bundleComponents | bundle_components | canonical UUID | bundle/component Variant |
| purchaseBatches | purchase_batches | canonical UUID | product group |
| purchaseBatchItems | purchase_batch_items | canonical UUID | Batch/Variant |
| privateOrders | private_orders | canonical UUID | product group |
| privateOrderItems | private_order_items | canonical UUID | Order/Variant |
| salesOrders | sales_orders | canonical UUID | N/A |
| salesOrderItems | sales_order_items | canonical UUID | Order/Variant |
| japanPackages | japan_packages | canonical UUID | N/A |
| japanPackageItems | japan_package_items | canonical UUID | Package and optional ERP links |
| outboundShipments | outbound_shipments | canonical UUID | N/A |
| outboundShipmentItems | outbound_shipment_items | canonical UUID | Shipment and optional ERP links |

Presence, Activity Log, restore metadata, and purchase idempotency runtime rows
are deliberately excluded from the snapshot.

## Safety boundaries

- Restore requires an authenticated `owner`; PUBLIC and anon cannot execute it.
- Every business-table mutation passes a transaction advisory-lock trigger.
- The RPC stores the pre-restore server snapshot before replacing any resource.
- One PostgreSQL function call is one transaction. A failure on resource 10 (or
  any statement) rolls back resource 1–9, the rollback-snapshot insert, and the
  idempotency claim together.
- Same actor/key and exact JSONB snapshot replays the canonical result. A
  different snapshot is refused with `RESTORE_IDEMPOTENCY_PAYLOAD_MISMATCH`.
- The post-write count and relationship hash must equal the prepared snapshot.
- Commit increments `erp_cloud_restore_epoch`; mounted clients use the normal
  draft-aware authoritative catch-up path. No row-by-row event assumption and no
  full pull are introduced.
- The current client atomically replaces all fetched Cloud cache collections in
  one IndexedDB transaction. Local authoritative IndexedDB is never opened.

## UI and harness

Settings uses: file selection → local preflight → count/hash review → typed
confirmation → second confirmation → RPC → authoritative refresh. Offline,
unauthenticated, non-owner, and non-Cloud states are refused.

`/__staging/cloud-restore-harness` reuses the normal App Auth session. Its
controller allows only the exact Staging project ref and a non-production
runtime. Production, Local, missing, and unknown environments fail before the
restore callback. It never displays or copies an auth token.

## Migration status

`023_cloud_atomic_json_restore.sql` and `024_cloud_restore_snapshot_export.sql`
have separately completed their Staging apply/postflight gates. Production has
not been touched.

`025_cloud_atomic_restore_execution_timeout.sql` is a review/build artifact. It
replaces only the Restore RPC implementation and adds private profiling helpers:

- the full pre-restore snapshot is built once and reused as the rollback payload;
- the post-write check uses per-table count/identity hashes plus required-FK
  checks and a relationship hash, without constructing another full snapshot;
- all inserts remain set-based through `jsonb_populate_recordset`;
- only `erp_restore_cloud_snapshot` receives a bounded 30-second function
  timeout; global role/database timeout settings are not changed;
- phase timing logs and the canonical result contain durations only, never the
  snapshot, credentials, or business payload.

025 has not been applied to Staging or Production. A separately authorized SQL
gate must verify function configuration and live 16,055-row timing before the
Restore write gate resumes.

## Request boundary evidence

The browser calls the Database REST RPC directly through `supabase.rpc`; this
path does not install a shorter client-side `AbortController` deadline. The
previous 15.5 MB request reached PostgreSQL and returned SQLSTATE `57014`, so the
active browser/Data API path accepted that request body and the proven blocker
was the database statement timeout. The 30-second function bound remains below
the documented 60-second maximum configurable Database Client API timeout.

`test:cloud-restore-execution-cost` uses a generated 15-resource, 16,055-row,
15,532,358-byte fixture for repeatable local cost-model evidence. It is not a
substitute for the separately authorized Staging PostgreSQL timing gate.
