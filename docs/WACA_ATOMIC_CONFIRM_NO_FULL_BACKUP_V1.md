# WACA atomic confirm without a full ERP pre-backup

Base: `4935fcd338f95ba3cc376fe575a37f5c8e2a8375`.
Schema: unchanged canonical v9 / ERP2_SEMANTIC_SCHEMA_V3. No migration.

## Transaction boundary and exact impact

- `WacaIntegration.confirmImport`: removes only normal Confirm's `exportData` call; verifies preview revision, calls the atomic helper, reads the committed ledger/quantities, performs existing targeted product refresh, and waits for the actual shared Global Sync presentation before showing the modal. No fake freshness or second business transaction. Historical Pending remains visible/countable without automatically rendering the entire manual-choice page behind the completion modal.
- `confirmFlow`: schema-neutral orchestration using the existing `erp_commit_waca_snapshot` adapter. All six existing arrays and revision/CAS arguments remain. Only changed UPSERT rows are sent; omitted rows stay durable and SQL recomputes from all stored orders. Unexpected removals fail closed. No new resource, field, RPC, identity, or serializer. Empty-string variant FK projection and null both mean unmatched; non-empty identity is never normalized away.
- Response loss: SELECT the exact existing batch identity and compare request receipt plus ledger contents/revision; no automatic replay. A missing/mismatched receipt stays UNKNOWN. Independent reconciliation verifies stored quantities/mappings, excluding unresolved sources from applied quantity.
- `nextStorage`: existing optional batch reconciliation is now persisted inside the same IndexedDB transaction as orders/mappings/quantity, instead of a second post-commit audit transaction. NEXT still receives the complete snapshot, never the Cloud UPSERT delta.
- `importErrors`: adds explicit stale-CAS classification; existing backup errors remain for explicit maintenance and other backup users.
- `reviewed-change-impact`: registers exact test commands only; no Guard allowlist or safety predicate change.
- Tests: normal Confirm download expectations are replaced by hard zero-backup assertions and complete synced-modal checks. Earlier Backup transport/native tests retain manual Backup, ACL, timeout and Restore coverage; their obsolete mandatory-pre-backup Confirm fragment moves to the new real-browser/native atomic-confirm suite.

One Cloud RPC transaction owns `waca_orders`, `waca_order_items`, `waca_mappings`,
`waca_master_links`, `waca_import_batches`, `waca_cutover_audit`, `waca_state`,
and derived `product_variants` quantities. Existing advisory locks, row-lock/CAS,
integrity checks and exception rollback remain unchanged. No SQL source changes.

## Correction versus rollback

A successful but wrong business input is not a failed transaction. Reimporting corrected
rows with the same order/item identities replaces quantities/status rather than adding;
cancelled/failed orders no longer contribute. Manual mapping corrections re-evaluate
history. Orders and audit remain durable. Merely omitting an old order from a later file
does **not** delete/cancel it; the user must explicitly supply its corrected status or
quantity. There is no invented Undo Import or whole-ERP Restore requirement.

## Verification boundary

The exact incident XLS is read locally, SHA-256 checked, and used only in disposable
PostgreSQL/PostgREST and isolated browser contexts. The benchmark renders the real
WacaIntegration, Cloud provider, targeted cache and shared Global Sync boundary.
Start: actual Confirm click. End: visible success dialog AND shared sync `fresh`.
One warmup plus five measured runs. No production Confirm is performed; production
latency remains a user retest, not a claimed measurement.

Required gates: rollback with a late transaction failure, CAS zero-effect rejection,
lost-response exactly-once reconciliation, five repeated imports, exact quantities
G07595265=1 / G07607190=2 and revision 8→9, 24-resource Restore parity including
all 37 outbound timestamps, Cloud→NEXT/Deadline, parser/resolver/rebaseline,
TypeScript/lint/build, Git remote/checkpoint, exact-impact and fresh-schema Guard.

Settings Backup/Restore, 041/042/043 short EXECUTE, recovery tooling, Deadline,
BuyAnime, Inventory/Catalog and migrations 052–055 are not modified.
