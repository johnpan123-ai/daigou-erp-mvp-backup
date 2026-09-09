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

`supabase/sql/023_cloud_atomic_json_restore.sql` is an artifact only. It has not
been applied to Staging or Production and must receive a separate deployment
authorization and postflight review.
