# Large Catalog commit release review

## Incident truth

Trace `b2195e48-1dda-4aeb-84bd-49b4d9a72599` originally reached PostgreSQL
57014 at 2026-10-09 00:13:33 Asia/Taipei. That cancelled transaction is not a
successful commit. The same batch now has an exact completed Catalog receipt
at 00:14:38 and a COMPLETE journal. All 1,772 authoritative operations match.
The later successful caller cannot be identified from retained evidence.
Do not replay Inventory or Catalog for the original batch.

## Measured change

The exact receipt has 643 Group creates, 58 Category creates, 1,064 Variant
creates and 7 Variant patches; no redundant IDs or no-op patches.
The old Catalog calls the shared field RPC, which dynamically writes each row
and repeatedly appends full returned rows to a growing JSON array. Catalog
does not consume those returned rows. The isolated baseline attributes most
time to these Group/Variant mutations. The original server log does not expose
inner phase timing, so its exact internal timeout phase remains unobservable.

070 introduces a private Catalog-only helper: unchanged field CAS/advisory
locks/whitelists followed by typed set-based writes grouped by touched fields.
Omitted CREATE fields keep database defaults; explicit NULL remains NULL.
All entities still commit in one outer transaction with complete dependency CAS,
056 provenance protection, relationship checks and an exact durable receipt.
The shared field RPC, executed migrations and global authenticated timeout are
unchanged. No table, column, index or backup resource is added.

An editor/actor-scoped read-only reconcile RPC fences receipt reads with a
NOWAIT lock: completed exact request => COMMITTED; safely absent receipt =>
NOT_COMMITTED at observation; conflicting/in-flight evidence => UNKNOWN.
Idempotency still protects a subsequent same-key attempt. Committed recovery
does not redispatch operations; unknown evidence never permits a replay.

## Runtime boundaries

The pipeline retains existing Inventory proofs and never redispatches Inventory
on resume. WACA remains outside BuyAnime completion. Catalog-phase scheduling
defers background Inventory cache/bootstrap reads until the RPC resolves,
retaining Realtime/focus/reconnect requests and cancellation. A forced bootstrap
cannot fork an existing pull. Static caller labels are recorded in diagnostics;
original trace callers cannot be retroactively identified.

070 is SCHEMA_CONTRACT_SENSITIVE and requires real migration reconciliation,
not a schema-neutral SAFE_DESCENDANT exception. Canonical v24 is a new baseline;
v23 remains immutable. Optional timing evidence lives in existing OPS receipts
and local diagnostics, not a new portable business resource.

## Permanent gates

- Exact production-scale Catalog fixture, 20 actual commits and row proof.
- Forced mid-transaction FK failure rolls back Groups/Categories/Variants/receipt.
- Committed/absent/unknown reconciliation; response-loss replay zero.
- Same-file five times; guarded Purchase projection; WACA decoupling.
- ERP1 raw v1/15 and current ERP2/24 Restore, timestamps, 041/042/043,
  269-byte Execute, Cloud-to-NEXT and Deadline compatibility.
- TypeScript, changed-line lint, NEXT and ERP2 builds, remote checkpoint,
  PRE_ADOPTION and POST_ADOPTION formal guards.

Private snapshots, request bodies, customer data and credentials are excluded
from Git. Live acceptance must use an equivalent safe fixture, never reupload
the already-completed incident XLS.
