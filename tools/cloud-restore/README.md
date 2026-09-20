# Cloud Mode JSON Atomic Restore

This experimental path replaces Cloud authoritative data only through
`public.erp_restore_cloud_snapshot`. The browser performs parsing and preflight,
but PostgreSQL owns the maintenance lock, rollback snapshot, idempotency claim,
resource replacement, integrity readback, and commit/rollback decision.

## Resource matrix

| JSON collection | PostgreSQL table | Identity | Relationship checks |
| --- | --- | --- | --- |
| inventory | inventory_items | canonical UUID `id`; `inventory_key` is a UNIQUE importer/domain key only | N/A |
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

`025_cloud_atomic_restore_execution_timeout.sql` has completed its separately
authorized Staging apply. It replaced only the Restore RPC implementation and
added private profiling helpers:

- the full pre-restore snapshot is built once and reused as the rollback payload;
- the post-write check uses per-table count/identity hashes plus required-FK
  checks and a relationship hash, without constructing another full snapshot;
- all inserts remain set-based through `jsonb_populate_recordset`;
- only `erp_restore_cloud_snapshot` receives a bounded 30-second function
  timeout; global role/database timeout settings are not changed;
- phase timing logs and the canonical result contain durations only, never the
  snapshot, credentials, or business payload.

`029_cloud_restore_live_schema_alignment.sql` is the next review/build artifact.
It fail-closes unless the current parity post-state is present: all 15 Restore
tables have an `id uuid NOT NULL` single-column primary key, while
`inventory_items.inventory_key` is `text NOT NULL UNIQUE` and not the primary
key. It updates Restore profiling to hash UUID `id`, and upgrades only the fixed
15 child-first DELETE statements to `WHERE id IS NOT NULL`; it does not change
safeupdate settings. 029 has not been applied to Staging or Production.

POST-CLOUD HARDENING TODO: reconcile the Settings `erp_healthcheck` dependency
separately. Cloud Restore does not depend on that table and this artifact does
not change it.

## Request boundary evidence

The browser calls the Database REST RPC directly through `supabase.rpc`; this
path does not install the four-second read-fallback `AbortController` deadline
and never automatically retries a Restore. Trace
`6e9acdcc-7f23-44c5-a890-2f8f4271069c` reached PostgreSQL and failed with
SQLSTATE `57014` in the `integrity` phase after 46,664 ms. The database function
stack still carried the historical 30-second function setting, so the proven
blocker was the Server statement-timeout contract, not the browser fallback.

`036_cloud_restore_final_closure.sql` is the unapplied candidate that requires
the exact 035 post-state. It gives the validator, effective builder, legacy
atomic writer, and effective wrapper one explicit bounded 120-second Restore
budget; combines each table's audit count and NULL materialization into one
JSON traversal; retains the final portability validator before the first
DELETE; keeps legacy authenticated execution revoked; and emits safe structured
failure metadata without snapshot rows, Auth identities, or credentials.
Transport-uncertain clients perform one RLS-protected request-status read and
do not resubmit the Restore.

`test:cloud-restore-final-closure` additionally uses the actual 15-resource,
17,658-row snapshot when it is present at the explicitly supplied fixture path.
It verifies the 15,395 audit transformations, effective fingerprint, source
immutability, rollback matrix, replay semantics, safe 57014 output, and bounded
candidate preparation. This is not a substitute for applying 036 and timing a
real PostgreSQL Restore in a separately authorized gate.
