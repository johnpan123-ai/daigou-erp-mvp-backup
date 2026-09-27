# WACA order integration core v1 — isolated design record

Status: pre-integration only. Based on ERP 2.0 product source `bb396baf25120ce1b84f5784ee2ef29345b7e342`. No live schema, business data, ERP route, NEXT, or Experimental changes are part of this branch.

## Existing architecture (source audit)

- `src/utils/myacgParser.ts` reads `主編號(多規格編號)` into the inventory item's `myacg_parent_code` and `子編號(商品編號)` into `myacg_item_code`. `src/lib/db.ts` then creates/updates ProductGroup and ProductVariant while preserving variant UUIDs. The Cloud `product_variants` schema in `supabase/sql/002_core_erp_tables_mvp.sql` stores child `myacg_item_code` but **does not persist parent `myacg_parent_code`**. A child code cannot in general be inverted to recover its parent. A future WACA integration needs an explicit, versioned read-only parent/child master crosswalk, or an independently reviewed schema addition. It must not infer the parent from a product title or `getBaseSku`.
- ProductGroup and ProductVariant use UUID primary keys. `product_variants` already has `myacg_auto_quantity`, `effective_myacg_quantity`, `myacg_manual_adjustment`, `waca_auto_quantity`, and `waca_manual_adjustment`. Existing display calculation is the automatic WACA quantity plus the manual adjustment; MyACG has its own calculation. No WACA import may rewrite the MyACG side or manual adjustments.
- `src/pages/OrdersImport.tsx` and `sales_orders` / `sales_order_items` are MyACG-oriented. That importer may create product master records, which WACA is prohibited from doing. `supabase/sql/005_sales_orders_sync.sql` makes `sales_orders.order_number` globally unique, requires `buyer_name`, and has no durable WACA feature, batch, mapping, or per-source order-item key. `sales_order_items.myacg_item_code` is required. These are unsafe to reuse directly for WACA.
- `src/lib/db.ts` has existing order-derived recomputation that writes `waca_auto_quantity` from the current order demand map. Future integration must reconcile this existing writer before enabling a second WACA writer; otherwise a refresh could overwrite the imported aggregate. This branch does not alter it.
- Reusable: ProductVariant UUID and WACA quantity display fields, current UI layout tokens, read-only MyACG parser semantics. Not reusable without redesign: MyACG order importer, `sales_orders` uniqueness/required fields, product creation/upsert path, and implicit parent-code inference.

## Actual workbook and safe matching

The test reads the user's confirmed `waca資料.xlsx` and a separate actual MyACG export plus the user-provided ERP JSON snapshot from local files; none is committed. The two-row WACA header yields 127 data rows, 71 orders, 12 discount rows, 115 product rows, and 60 distinct WACA features. Status rows: 處理中 97, 完成付款 25, 取消 4, 失敗 1. A feature is a stable JSON tuple of product code, title, spec1, spec2 after only width, whitespace, and English-case normalization. Discount lines remain in import statistics but never enter matching or demand.

Direct child-code match takes precedence. Otherwise matching is confined to the named MyACG parent and its children. Specs are primary; title verifies; price is not identity. Zero candidate stays unmatched, multiple candidates require review. No first-item fallback, cross-parent auto-match, or product creation is allowed. An existing permanent feature mapping is reused on later imports. Manual remap recomputes every affected historical effective item in the isolated repository.

With the available local master export/snapshot, the regression obtains **52 unique matches / 8 unmatched / 0 multiple** (52/60 = 86.7%). The eight unmatched features occur in ten order-item records in the preview. Matched product rows are **105/115**, not the previously reported 106/115. The prior 106 count was a historical summary, not a reproducible assertion for this master/snapshot pair. The one-row difference must be reconciled against the original master version before any live integration; no matching rule was relaxed to force 106.

Unmatched features (diagnostics from the test run):

| WACA code | Spec1 | Diagnosis | Parent children |
| --- | --- | --- | ---: |
| GP00379558 | 我們團長的壓克力立牌 | MASTER_NOT_FOUND | 0 |
| GP00396628 | 徽章 | MASTER_NOT_FOUND | 0 |
| GP00396312 | Gamers原創寫真卡 | NAME_CONFLICT | 1 |
| GP00396312 | KADOKAWA STORE 限定特裝版 | NAME_CONFLICT | 1 |
| GP00379359 | 親簽套組 | MASTER_NOT_FOUND | 0 |
| GP00392293 | 親簽套組 | SPEC_NOT_FOUND | 5 |
| GP00378031 | 雙面壓克力立牌 | MASTER_NOT_FOUND | 0 |
| GP00378031 | 與トワ大人同款帽子 | MASTER_NOT_FOUND | 0 |

The test logs the corresponding complete WACA title and spec2; the import result never silently discards unmatched items.

## Pure-core contracts

`src/waca/orderCore.ts` has an in-memory repository only. WACA order key is `WACA + order number`; item key is order key + feature. Same-order duplicate feature rows are folded before upsert. Repeat or overlapping imports replace keyed values rather than incrementing prior totals. Orders missing from a later file remain unchanged. An order whose rows disagree on status returns `STATUS_CONFLICT` and is not updated. Processing/payment-complete counts; cancelled/failed remains recorded with effective quantity zero. Automatic quantity is recomputed from all effective mapped items; manual adjustment remains a separate value. The import summary exposes insert/update/unchanged, discount, conflict, match, quantity reconciliation, and per-variant before/after changes.

This is deliberately **not** a live transactional repository. Before persistence, the production adapter must validate the entire batch and commit orders, items, mappings, batch record, and aggregate quantity in one OWNER-guarded transaction. It must preserve a stable source/feature key and reject conflicting order status; never expose direct arbitrary-table writes to the browser.

## Schema choice and proposal (no migration source in v1)

Recommendation: dedicated `waca_import_batches`, `waca_orders`, `waca_order_items`, and `waca_product_mappings`. Extending `sales_orders` requires weakening MyACG-specific NOT NULL and global uniqueness and introduces shared importer/RLS risk; only ProductVariant UUID and existing WACA quantity fields should be reused.

Proposed keys: batches by UUID plus content fingerprint; orders UNIQUE `(source, normalized_order_number)`; items UNIQUE `(waca_order_id, feature_hash)` with full normalized feature stored for collision verification; mappings UNIQUE `(feature_hash)` with full feature, MyACG parent/child IDs, ERP variant UUID, AUTO/MANUAL, historical names, confirmed timestamp, current master status. Index item order/variant, mapping variant and source keys. Aggregate automatically from effective mapped rows, not from old `waca_auto_quantity` plus new rows. The source adapter must have an explicit way to resolve the MyACG parent/child crosswalk and a single owner of `waca_auto_quantity` updates.

RLS design for a later reviewed migration: enable and force RLS on every new table; revoke PUBLIC/anon direct access; explicit Data API grants rather than default privileges; authenticated OWNER-only mutation RPC with fixed `search_path`, constrained row reads, atomic batch validation/upsert/recompute, idempotency fingerprint, and stale/CAS safeguards. Test fresh project, preview branch, reset, duplicate import, failed transaction rollback, and manual remap. Rollback is by pre-apply snapshot plus reversible additive schema; do not delete original MyACG data or edit historic imports to fake a pass.

No migration source is created in v1 because the Cloud parent-code crosswalk and the existing `waca_auto_quantity` writer ownership are unresolved integration decisions. Applying an apparently complete table schema before those contracts are settled would create a misleading deployable path. Migration Apply = 0.

## Isolated preview

`waca-preview.html` is a separate Vite entry at local port 4194, not linked into ERP navigation. It imports no ERP provider, API client, or proxy. File data and mappings remain in React/in-memory repository and vanish on reload. Screens: import, result, orders, mapping, unmatched/manual selection, status conflicts, import history. The preview can analyze the real local workbook together with local MyACG export and ERP snapshot. It cannot write to Supabase, Cloudflare, ERP local store, or business tables.

## Later integration gates

1. Human acceptance of NEXT 4192, then separate Experimental reconciliation; do not merge this branch into either environment now.
2. Resolve master parent/child persistence and the existing WACA auto-quantity writer.
3. Review an additive migration and transaction/RLS/ACL contract in isolation, then fixed-head revalidation.
4. Only then target WACA core integration into Experimental, with independent deploy and live-data authorization.
