# BuyAnime post-Restore recovery lifecycle

## Forensic outcome

The new request `catalog_import_d0d1d4b6-e121-474a-94a4-7afd1ff6f728`
stopped after T05, before backup, planning or any business dispatch. Fresh
management SELECT evidence found zero Inventory request rows, zero journal
rows, and no Catalog/WACA idempotency receipt. The scanner itself is SELECT-only.
This attempt is NOT_COMMITTED / BUSINESS_WRITE_NONE, not a response-lost commit.

The successful ERP1 Restore advanced epoch 12 to 13 at
2026-10-05T13:16:10.930276Z (completed 13:17:06.033313Z). Restored Inventory
contained the historical batch `catalog_import_1791127492375`, 1,520 rows,
observed 2026-10-04T15:24:52.375Z. That same batch appears in the authenticated
exact ERP1 snapshot. The scanner incorrectly reconstructed it as a current
unfinished import. The UUID-only journal assertion raised BUYANIME_JOURNAL_INVALID;
generic commit-phase formatting then reported COMMIT_RESULT_UNKNOWN and an RPC
which had not been called. The newly generated request was not reused.

363 Variant timestamps after Restore were also observed. They are not attributed
to this request: there is no Inventory dispatch or request receipt and the failing
scanner does not write Catalog. Do not claim all concurrent user activity was zero.

## Existing state policies (unchanged)

| Structure | Classification | Restore policy / current handling |
| --- | --- | --- |
| Inventory latest import ID/time | Business durable provenance | Shared Restore, retained literally; old timestamp only proves superseded recovery, never rename IDs |
| import_batches business rows | Business durable | ERP1 v1 existing RESET; current 24-resource Restore retains exact rows |
| BuyAnime journal in details JSON | Operational durable subtype | Same existing import_batches policy; preserve retained audit, classify generation before resume |
| erp_idempotency_keys | Environment-local operational receipts | Preserve; never delete or replay an old-generation intent |
| erp_cloud_restore_epoch / attempts | Environment-local operational authority | Existing Restore advances epoch atomically; preserve historical execution evidence |
| BuyAnime verified/touched/refresh maps | Ephemeral derived client evidence | Drop only superseded in-memory entries, not business data; reload scans server authority |
| localStorage / IndexedDB cloud cache | Derived presentation cache | Not request identity authority; no persisted BuyAnime request reuse |
| WACA, Deadline, baseline/ledger | Existing durable/operational contracts | Unchanged |

## Minimal fix

Reuse the existing server epoch. New journal records carry optional restoreEpoch
inside their existing JSON details, with matching compressed header. No new SQL
column, required business field, resource, migration or serialization version.
Pre-epoch evidence is superseded only if its valid observation time strictly
predates a proven successful Restore. Equal timestamps, missing/unreadable epochs,
future epochs and malformed evidence fail closed. An active current-generation
unknown outcome still blocks/reconciles; it is not discarded.

Verify generation at discovery, planning, commit/readback and resume boundaries.
Keep Inventory exactly-once, Catalog stable-key replay, row hashes/CAS, targeted
authoritative refresh and the real success-modal + SYNCED gate. No journal,
receipt or Inventory marker is deleted or rewritten merely to clear recovery.

## Permanent release gate

`npm run test:erp2-post-restore-release-gate` requires private exact ERP1/current
ERP2 snapshots, the exact 1,003,843-byte / 1,551-row XLS and real WACA fixture.
It executes native disposable Restore, exact 15/current24 parity, 37 timestamps,
041/042/043 short Execute/rollback, ERP1 Restore -> immediate BuyAnime success,
current ERP2 Restore -> immediate BuyAnime success, retained stale audit/no replay,
same-file five times, and ERP1 Restore -> immediate atomic WACA import/readback.
SAFE_DESCENDANT runtime releases require these executed gates automatically.
Schema/RPC releases must also run this gate before promotion; exact-baseline
deployment identity never substitutes for compatibility evidence.

No agent re-import is authorized. After a verified deployment, the user may
reselect the XLS because this new request did not reach business commit.
