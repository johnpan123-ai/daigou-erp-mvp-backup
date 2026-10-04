# BuyAnime / WACA critical-path separation

BuyAnime owns Inventory and Catalog. WACA owns orders and quantity. Completing
a BuyAnime import no longer reads or writes WACA evidence, master links, state,
orders, quantities or snapshots. There is no deferred WACA mutation after the
success dialog. The independent WACA route continues deriving parent/child
evidence from authoritative Inventory and ProductVariants using the existing
resolver and explicit WACA import boundary.

## Success boundary

The existing UI waits for file parsing, pre-import backup, Inventory commit and
proof, Catalog transaction and proof, journal CAS completion, targeted verified
cache absorption and shared Global Sync convergence. Only then may it show the
success dialog. No timeout, optimistic sync flag or partial commit is success.

## Historical WACA-pending journal

An older `WACA_EVIDENCE_PENDING` journal is not proof that WACA committed.
Recovery first checks every pinned Inventory field hash, then SELECTs current
Catalog rows and verifies that the existing Catalog planner has zero remaining
operations. Any mismatch or journal CAS conflict fails closed. Only the existing
operational journal is completed; Inventory, Catalog and WACA business writes
are never replayed on this branch. The old WACA intent is retained as audit
evidence, not rewritten as a committed receipt.

## Preserved contracts

No migration, durable field, resource, RPC signature, serializer, Backup registry,
Restore transaction, quantity calculation or WACA resolver change. Migration
052/053, canonical schema v7, baseline, UUID/CAS identities and normal business
operations are unchanged. NEXT's BuyAnime upload also stops writing WACA stores.

## Measured isolated acceptance

The actual 1,520-row XLS and its exact local pre-import backup were replayed only
inside fresh disposable loopback databases. Five cold runs, each exercising 10
new and 1,510 updated rows, measured file selection through synced success dialog:
median 4,164 ms; nearest-rank P95 4,608 ms. Three no-change repeat runs measured
median 858 ms and P95 882 ms. Every run had zero WACA requests, zero critical
requests after success and zero production writes. These are isolated measurements,
not a claim that production WAN/database latency has already met the same target.

Tests cover unavailable WACA reads/writes, 0/1/10/100/829/1,000 legacy deltas,
preserved WACA quantity/revision, Catalog and Inventory mismatch, journal CAS
failure, real provider close/relogin recovery, unchanged UUIDs, existing Backup
journal preservation and independent WACA parent evidence derivation.

Deployment remains conditional on exact-hash change-impact evidence, remote Git
verification, a clean fixed source, fresh canonical live evidence and the full
SAFE_DESCENDANT Guard. The agent must not replay the production import incident.
