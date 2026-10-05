# WACA pending history and count semantics

The 2026-10-05 management-side SELECT-only investigation confirmed that the
displayed 127 entries were already present before the latest successful import.
There are 84 unresolved saved order lines, representing 45 distinct features,
plus 43 overlapping effective-quantity reconciliation summaries. There are no
status conflicts or other reconciliation errors in this evidence. This is not
127 newly failed products. The latest saved batch has 14 orders, 17 product
lines, 13 distinct features, 17 matched lines and zero unmatched lines.

All 84 unresolved lines have a blank specification code. The current master
has no proven parent relationship for 82 of them; the other two have a parent
anchor but conflicting product names. An isolated dry-run with the fresh
current master resolves none of them. Existing explicit-spec matching, safe
parent/name resolution, manual decisions and quantity exclusion must remain
unchanged. No fuzzy title selection or product-code-to-Variant fallback is
permitted. A controlled new-master fixture resolves its historical order
without any BuyAnime-to-WACA evidence write.

## Minimal presentation fix

- Keep the existing tab total and all pending rows/actions.
- Explain the distinct units: unresolved order lines, distinct features,
  overlapping effective-quantity summaries, other reconciliation errors and
  status conflicts.
- Display the last **completed** batch separately. Its unmatched line count
  is not a count of newly created historical records. Without a saved batch,
  explicitly report that the latest-file result is unavailable.
- When that completed file contains no unmatched/conflicting lines, distinguish
  the remaining historical work from a current-file failure.
- Label unresolved reconciliation codes as WACA product codes, not verified
  Variant SKUs.

All non-JSX runtime statements remain AST-identical to the recovery HEAD
`bf8185c4cadcffbfc6ccc11b0cfd13324df37311`. Provider calls, transactions,
durable fields, matcher/recompute, Backup/Restore, canonical schema and
migration sources are unchanged. The new UI fixture asserts 84 + 43 = 127,
45 distinct features, honest missing-batch/current-file-pending display,
read-only tab switches, zero external transport, and desktop/mobile layout.
The existing required provider regression executes these checks.

Private live snapshots and row-level forensic evidence are kept only in ignored
local recovery files; no live business rows are included in this document or
the synthetic fixtures. The pre-existing heavy pending-list rendering and old
parent-evidence test's removed BuyAnime critical-path expectation remain
separate inherited observations, not matcher regressions introduced here.
