# WACA resolver V3

Schema-neutral application release. No migration, provider wire-format, RPC,
durable resource registry, Backup/Restore or canonical fingerprint changes.

## Identity and evidence

Nonblank specification code is always the exact Variant SKU, including when it
equals the product code. A blank specification code never becomes a direct SKU
fallback. A proven parent permits strict specification-name matching or a sole
active Variant. Otherwise, indexed normalized product/specification evidence
must uniquely identify the Catalog target. Full token combinations preserve
token multiplicity. Alias matching without `代理版` requires one parent and one
Variant; collisions remain pending. No fuzzy score or first-candidate choice.

Lookup normalization handles width, whitespace, equivalent brackets/punctuation
and known leading selling decoration. Semantic years, versions, sizes and colors
remain. Durable feature, order, item, batch and UUID identities do not change.

Proven GP-to-parent evidence uses existing mapping JSON (`myacgMainId`, feature,
canonical Variant and optional resolution). It is revalidated against the current
Catalog; conflicting GP proofs, changed Variant cardinality and manual/spec-code
conflicts fail closed. The batch discovery pass is independent of row order.

## Real evidence (local private files only)

The existing 84 pending order rows / 45 features resolve in the fresh Catalog
dry-run. Seven workbooks contain 678 rows: 72 coupons and 606 product rows.
Independent exhaustive candidate enumeration proves 591 uniquely resolvable
rows, all correctly matched. The May workbook has 15 pending rows: nine absent
Catalog products and six genuinely ambiguous rows. No customer/order rows are
included in Git or this document; the per-feature evidence remains in ignored
local recovery files. `waca資料.xlsx` is the available 115-product-row old fixture;
there is no separate file literally named `old waca資料.xlsx`.

Clean disposable PostgreSQL replay, actual atomic RPC, full quantity parity,
same-file idempotency, CAS, rollback and response-loss readback are required.
Historical cutover audit is forensic evidence and is retained. No non-WACA
business fields may change. A pre-production live WACA rebuild requires a fresh
WACA-only export, revision/hash preconditions and an atomic WACA-only operation.

## Release gates

Fixed clean Git HEAD and remote checkpoint, exact per-file immutable review,
real regressions, canonical schema/ledger/baseline observation, approved artifact
and full SAFE_DESCENDANT Guard are mandatory before deployment. No path-wide
WACA allowlist is introduced. WACA Confirm still makes zero full ERP Backup
calls; BuyAnime remains decoupled. Settings Backup, 24-resource Restore, 37
outbound timestamps, Atomic Restore 041/042/043, short EXECUTE, Deadline and
Cloud-to-NEXT regression contracts remain intact.
