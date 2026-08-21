# Test Sandbox Feature Registry

Last updated: 2026-08-16 23:08 (Asia/Taipei)

## Rules

- One user-facing feature must have one independently reviewable feature commit and one readiness tag.
- Never merge `codex/test-sandbox` into `main`.
- Production releases always start from the latest `origin/main`, then cherry-pick only approved feature commits.
- Test infrastructure commits are never eligible for Production cherry-pick.
- Every release branch must run Build, core regression, local/Preview acceptance, and receive explicit approval before Production deployment.

## Production-ready feature nodes

| Feature | Status | Final commit | Tag | Production ready | Dependencies | Files changed | Data write | Schema | Manual acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A. Purchase detail official link | Ready as an isolated node | `b0673caab80f33a5ef2246f7fb9c546a19c737b1` | `feature-purchase-detail-official-link-ready` | Candidate; release validation still required | None | `src/pages/PurchaseManagement.tsx` | None; reads existing `ProductGroup.product_url` | No | Test Sandbox direction accepted; Production branch/Preview acceptance pending |
| B. Recent purchases workspace | Ready as one squashed feature node | `24cc27aac6f126470a8bc695d7b5b8a0e7924187` | `feature-recent-purchases-ready` | Candidate; release validation still required | None, including no dependency on Feature A | `src/App.tsx`, `src/components/layout/AppLayout.tsx`, `src/pages/RecentPurchases.tsx`, `tests/recent-purchases.mjs` | None; reads purchase batches/items and product groups | No | Local Test Sandbox layout accepted; clean Production-base cherry-pick and Build verified; Preview acceptance pending |
| B2. Recent purchases daily ledger copy | Ready as a focused follow-up node | `87120eba586f388fd867159d033f4719afcc80c8` | `feature-20260816-2304-recent-purchases-daily-ledger-ready` | Candidate; release validation still required | Apply after Feature B; does not depend on Feature A | `src/lib/purchaseBatchLedger.ts`, `src/components/PurchaseBatchTab.tsx`, `src/pages/PurchaseManagement.tsx`, `src/pages/RecentPurchases.tsx`, `tests/recent-purchases.mjs` | None; clipboard-only read of original purchase batches/items | No | Build, core, Recent Purchases, original per-batch ledger action, Sandbox guard and local browser copy notice passed; human acceptance pending |
| B3. Purchase ledger simple clipboard rows | Ready as a focused formatter follow-up | `d153dc55c3dd0b13b6e8a064e9b8ebe8b312f4cf` | `feature-20260816-2308-purchase-ledger-simple-rows-ready` | Candidate; release validation still required | Apply after B2 because it updates the shared formatter introduced there | `src/lib/purchaseBatchLedger.ts`, `tests/purchase-management-actions.mjs`, `tests/recent-purchases.mjs` | None; clipboard formatting only | No | Single/daily batch automated clipboard checks, Build and core passed; local daily copy notice passed; human paste-to-Sheet acceptance pending |
| C. Purchase Management action hierarchy | Ready as an isolated node | `34fb89a7d9530699129f4c8eed138b55d3847a42` | `feature-purchase-management-action-hierarchy-ready` | Candidate; release validation still required | None | `src/pages/PurchaseManagement.tsx`, `src/components/PurchaseBatchModal.tsx` | No new writes; existing handlers and write gates are unchanged | No | Automated Test Sandbox UI acceptance and clean Production-base Build passed; human acceptance pending |
| C2. Per-batch ledger copy restoration | Ready as a focused follow-up node | `4a08fc77c554b0fb72f891dc785771a69a0a86fc` | `feature-purchase-batch-ledger-copy-restoration-ready` | Candidate; release validation still required | Apply after Feature C | `src/components/PurchaseBatchTab.tsx`, `src/pages/PurchaseManagement.tsx`, `tests/purchase-management-actions.mjs` | None; restores only the existing clipboard UI action | No | Integration Build, core regression, and targeted action test passed |
| E. Unauthenticated Local Mode entry | Ready as an isolated node | `2450f21ef5d0ee96b3ed3ea1cf258e5c0096bb8a` | `feature-unauthenticated-local-mode-entry-ready` | Candidate; release validation still required | None; clean node is based directly on Production `c3756cd` and does not depend on Test Sandbox | `src/pages/Login.tsx`, `src/components/layout/AppLayout.tsx` | Writes only `erp_provider_mode=local`; no ERP data write | No | Cloud guest → Local OWNER, reload persistence, Settings visibility, Console, Build, and regressions passed locally; human acceptance pending |
| F. Purchase-batch freight allocation | Ready as an isolated node | `8b72220b463a91700cf4d3fc761ae766f3e78d92` | `feature-purchase-batch-freight-allocation-ready` | Candidate; release validation still required | None; clean node is based directly on Production `c3756cd` and does not depend on Test Sandbox | `src/components/PurchaseBatchModal.tsx`, `src/lib/purchaseBatchFreightAllocation.ts` | No immediate write; updates only the new-batch modal draft until the existing Save action is used | No | Cases A–G, integer-yen unit-cost rounding, no double-add, cancel/no-write, Build, core and Sandbox isolation tests passed locally; human acceptance pending |
| G. Bundle component display consistency | Ready as an isolated UI node | `b7e49019e391aa086204db01188291070209b297` | `feature-20260816-2257-bundle-component-display-consistency-ready` | Candidate; release validation still required | None at runtime; clean Production release must cherry-pick this node only | `src/lib/bundleComponentDisplay.ts`, `src/pages/PurchaseManagement.tsx`, `src/pages/JapanPackageDetail.tsx`, `src/pages/OutboundShipmentDetail.tsx` | None; read-only Product Group／Category／Variant ViewModel | No | WeatherPlanet 4-component browser verification, Build, core, Sandbox guard and outbound race tests passed locally; human direction accepted, Production release acceptance pending |

### Feature A behavior

- The first and second purchase-record levels use the same `ProductGroup.product_url`.
- One Product Group shows one official-site entry.
- The entry is hidden when no URL exists and opens in a new tab when present.
- No URL inference, new field, Provider change, or data write.

### Feature B behavior

- Dedicated `/recent-purchases` route and Sidebar entry between Purchase Records and Purchasing.
- Today, yesterday, recent 7 days, and recent 30 days filters; recent 7 days is the default.
- Product-name search and an optional “official site only” filter.
- Aggregation key is `Taipei calendar date + product_group_id`.
- Displays product name, daily purchased quantity, batch count, last purchase time, official link, detail link, and a read-only `proxy_agent` badge when present.
- Date sections are independently collapsible and start collapsed; expansion state is not persisted.
- Read-only ViewModel: purchase batches, purchase items, Product Groups, quantities, and timestamps are never modified.

### Feature B history retained for audit

The Test Sandbox history remains unchanged:

- `86a5ecb6b44e32f9af757c0325deeb577c30f359`: original PurchaseRecords card implementation.
- `9c0dc6347bdddecc9c3a09e9ce9ce469f365e0a3`: moved the feature to a dedicated page.
- `c77ed76`: added read-only proxy-agent badges and independently collapsible date sections.

Future Production work must cherry-pick only the final node `24cc27a`, not the historical sequence above. This node is based directly on Production `c3756cd`; its browser test uses an isolated Local fixture and does not require Test Mode or Test Sandbox infrastructure.

### Feature B2 behavior

- Every populated date heading exposes `複製當日帳目` even while the date section is collapsed.
- The clipboard text is generated from every original `purchase_batch` and `purchase_batch_item` on that Taipei calendar date, not from the merged Recent Purchases rows.
- The original `複製本批次帳目` action and the daily action share `formatPurchaseBatchLedger`.
- Copying does not expand the date section or modify purchase data, and shows a short `已複製當日帳目` notice on success.

### Feature B3 behavior

- Every clipboard row contains exactly two tab-separated columns: existing formatted product name and quantity.
- Batch names, purchase dates, cost columns, blank columns, separators, and blank rows are omitted.
- Copying multiple batches concatenates their original item rows with a single newline only; it does not rebuild from merged Recent Purchases rows.
- The shared formatter is the only output path for both per-batch and daily ledger copying.

### Feature C behavior

- Keeps `新增採購批次` as the direct primary action.
- Moves `私下登記` and the existing permission-gated `新增規格` action into `其他操作`.
- Hides the unused `複製已採購帳目` UI without deleting its underlying implementation.
- Gives purchase-batch and private-registration dialogs distinct colors, titles, and explanatory text.
- Does not change purchase-batch creation, private-registration storage, quantity calculations, Provider behavior, or database structure.
- Test branch verification commit `6a96293` includes the Sandbox-only browser regression test. Future Production work must cherry-pick only the clean node `34fb89a`.

### Feature C2 behavior

- Keeps the product-level green `複製已採購帳目` action hidden as specified by Feature C.
- Restores a clear `複製本批次帳目` action on each purchase-batch history entry without changing its clipboard formatter.
- Keeps batch date, style count, total quantity, total amount, expansion, edit, and delete behavior unchanged.
- Apply `4a08fc7` only after Feature C; it is a focused follow-up and does not depend on Test Sandbox infrastructure at runtime.

### Feature E behavior

- Cloud visitors see `進入本地模式` beside `管理員登入` on desktop, in the mobile account area, and on the Login page.
- The action only calls `setProviderMode('local')` and performs a full navigation to `/dashboard`.
- It does not sign out, clear Supabase tokens, clear IndexedDB, synchronize data, or perform Local-to-Cloud writes.
- After reload, the existing Local Mode role behavior supplies Local OWNER access and restores the Settings entry.
- Cloud Mode authentication and visitor permissions are unchanged; the feature has no dependency on Test Owner, Test DB, or Sandbox Guard.
- The Production-ready node is `2450f21`; the Test Sandbox implementation history must not be cherry-picked to Production.

### Feature F behavior

- Adds a Japanese-yen freight helper only to the new purchase-batch modal for non-proxy products.
- Eligible rows are determined only from the current modal draft: quantity greater than zero and unit cost greater than zero.
- Allocates freight proportionally by `quantity × unit cost`, keeps full precision through the proportional calculation, then rounds each final per-unit cost to a whole yen with standard positive-number rounding.
- The batch total and saved purchase-item costs use those rounded integer unit costs. Because quantity can exceed one, the actual rounded cost increase is allowed to differ slightly from the entered freight instead of introducing fractional-yen unit costs.
- Repeated allocation always starts from the captured pre-allocation costs; changing quantity, unit cost, or freight restores those base costs and requires recalculation instead of stacking freight.
- The allocation button never creates a batch or calls a Provider. Only the existing final Save action persists the resulting unit costs.
- Test Sandbox verification commits `fcdb4bf` and `bbdbfad` contain the targeted browser tests. Future Production work must cherry-pick only the clean node `8b72220`.

### Feature G behavior

- Bundle-component candidates and expanded bundle contents show `商品名稱｜規格名稱` plus a separate `SKU: ...` line.
- The same display helper is used by the Purchase Management bundle modal, all Japan Package bundle layouts, Outbound bundle expansion, and the Outbound physical-item summary.
- Existing `bundle_components`, selected component IDs, package quantities, shipment items, receiving state, and all write handlers remain unchanged.
- WeatherPlanet’s four `雨海ルカ` components are distinguishable by their existing category/product title and SKU without modifying stored data.

## Dual Sandbox environment nodes

| Environment | Branch | Commit | DB | Port | Storage namespace | Status | Production ready |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| Next Sandbox | `codex/next-sandbox` | `961ec41` | `daigou-erp-db-next-v1` | 4192 | `__hippo_next_sandbox__::` | Baseline implementation; parity and isolation tests passed; awaiting manual acceptance | **NO** |
| Experimental Sandbox | `codex/experimental-sandbox` | `0c61828` | `daigou-erp-db-experimental-v1` | 4193 | `__hippo_experimental_sandbox__::` | Same baseline implementation on an independent worktree; awaiting manual acceptance | **NO** |

Both nodes preserve the legacy `codex/test-sandbox` and `daigou-erp-db-test-v1`.
They add no Production feature and must not be cherry-picked to Production.
They use the fail-closed Sandbox network guard, local Test Owner, fixed DB
routing, and independent Snapshot import state.

### Performance baseline fields

For Sandbox performance work, record the following before any optimization:

- Snapshot filename and SHA-256 when available.
- Collection counts and collection hashes after import.
- Snapshot import duration.
- PurchaseRecords first load and reload duration.
- Repeated search, sort, and category-switch duration.
- Inventory parser duration for a fixed 1300-row fixture.
- Production Supabase request count.
- Whether the measurement changed application code or data.

The current dual-Sandbox baseline is measurement-only. It does not claim that
an optimization has been implemented.

## Next-only Catalog Closing Date Field Test node

| Scope | Integrated commits on `codex/next-sandbox` | Source commits | Status | Production ready | Dependencies |
| --- | --- | --- | --- | --- | --- |
| Product Identity Matching v1 | `308485b` | `be525c6` | Implementation Passed / Awaiting Large-scale Manual Field Test | **NO** | Next catalog API |
| Read-only Catalog API availability / fail-closed errors | `59d96c4` | `b63d4c8` | Implemented + automated test; real upstream availability remains environment-dependent | **NO** | Vite read-only proxy |
| Size metadata and Golden Cases | `f579c67` | `dcc8ea0` | Implementation Passed / Awaiting Large-scale Manual Field Test | **NO** | Identity v1 |
| Same-identity supplier selection with Wanrong default priority | `37eaf94` | `079ce89` | Implementation Passed / Awaiting Large-scale Manual Field Test | **NO** | Identity v1 |
| Field-test diagnostics panel and log protocol | local follow-up | — | Implementation Passed / Awaiting Large-scale Manual Field Test | **NO** | The four nodes above |
| Identity Parser v2 legacy + Matching Pilot | `f99aba2`, `a4a5868`, `b852f42` | — | **Frozen; no further Matching expansion** | **NO** | Existing runtime decisions retained only for regression safety |
| Parser v2.1 Subject Extraction Rewrite | `c979ccc` | — | **Implemented + automated tested / Awaiting Manual Acceptance** | **NO** | Next-only Shadow; no last-token fallback; no Matching or closing-date authority |
| Structured v2 Query fallback + real 4192 probe | current Next development | — | **Closing Date Lookup v2 Development / Confirmed Version False Positive Blocker** | **NO** | P21-11 proved v1 could select PLAMATEA Black Barrel for the standard product |
| Matching v2 default-version compatibility | `510b24d` | — | **Fixed + automated tested / Awaiting Human Field Test** | **NO** | Next-only v2 Pilot; requires exact subject and structural/series evidence |
| v1 MATCH version safety veto | local implementation | — | **Implemented + automated tested / Awaiting Manual Acceptance** | **NO** | Next-only; v2 can only veto a reliable one-sided identity-bearing version conflict |

This node is intentionally not listed as Production-ready. P21-11 confirmed a
high-priority false positive: the PLAMATEA standard product could inherit Black
Barrel Edition's deadline because v1 MATCH returned before v2 saw the explicit
version conflict. The local safety-veto implementation blocks that write path,
but the blocker remains open until manual acceptance. `product_groups.proxy_agent`
supplier override behavior remains a separate business-rule review item; no
override is inferred from missing source evidence.

Parser v2.1 deliberately runs as a Next-only shadow parser. It promotes a
Subject only from explicit semantic evidence (known product-line grammar,
role-delimited names, a supported multi-token personal-name shape, or a full
compound-subject set). If no such evidence exists, it returns
`UNRESOLVED_SUBJECT` with an empty Subject list; it does not promote the final
remaining token. Matching v1/v2, queries, scores, selected candidate, supplier,
deadline resolution, and all writes remain unchanged until a separately
approved integration stage.

### Closing Date Evaluation Dataset expansion — 2026-08-19

| Node | Evidence | Status | Production ready | Scope |
| --- | --- | --- | --- | --- |
| 44-case real-product dataset | `tests/fixtures/closing-date/dataset.json`; `test:closing-date-evaluation` | **Dataset Expanded / Awaiting Matching v2 Design** | **NO** | Read-only capture plus offline replay only |

The expansion covers GSC/Nendoroid, figma, POP UP PARADE, scale figures,
SEGA/prize lines, FuRyu, Chocopuni, Bandai, and other lines selected from the
fixed Production JSON snapshot. New cases are `OBSERVE` until manually
confirmed; no threshold, ambiguity guard, supplier priority, closing-date
business rule, ERP DB, or Production data was changed.

The v2 Field-Test Candidate adds a bounded Next-only structured query fallback
(maximum five planned queries, only after the existing v1 candidate path has no
safe decision). Real 4192 probes confirmed five correct matches and zero false
positives. Version-less Star Platinum, unverified TAKARATOMY naming, special SMP
product-set mapping, and Omaneko remain fail-closed. This is not Manual Accepted
and must not be promoted to Production Candidate or Production Ready.

### Closing Date Resolution Workbench migration line — 2026-08-21

| Migration | Commit | Checkpoint | Status | Production ready | Boundary |
| --- | --- | --- | --- | --- | --- |
| Domain Foundation | `1d7bc27` | `checkpoint-20260821-0657-closing-date-domain-foundation-awaiting-storage` | Automated Tested | **NO** | Pure TypeScript contracts only |
| Next Sidecar Storage | `326a3d8` | `checkpoint-20260821-0728-closing-date-sidecar-storage-awaiting-batch-gateway` | Automated Tested | **NO** | Six Next-only Sidecar stores; no ProductGroup schema change |
| Read-only Batch Gateway | `1d79605` | `checkpoint-20260821-0806-closing-date-batch-gateway-awaiting-workbench-ui` | Automated / Performance Tested | **NO** | Batch, polling, snapshot/cache, dedupe, single-flight, cancel/retry; no ERP write |
| Next Workbench UI + atomic apply | `ddbfed4` | `checkpoint-20260821-0901-closing-date-workbench-ui-awaiting-manual` | **Implemented + Automated Tested / Awaiting Manual Acceptance** | **NO** | Next-only lazy UI; analysis/remember are Sidecar-only; final apply is guarded Next IndexedDB transaction |
| Candidate Retrieval v2 | `5e70bff` | `checkpoint-20260821-1019-closing-date-candidate-retrieval-v2-awaiting-manual` | **Implemented + Runtime Tested / Awaiting Manual Acceptance** | **NO** | Native Catalog `limit=5`、高資訊 query、progressive stop、native rank/query evidence；Analysis 0 ERP write。公開 Catalog 最終 live gate 因 upstream HTTP 500 待重測 |

The Workbench line is not a Production candidate. It depends on Next-only
storage and feature flags, has no Cloud RPC/Supabase implementation, and must
not be cherry-picked as an ordinary Production feature. Migration 5 has not
started.

## Test infrastructure nodes — never cherry-pick to Production

| Infrastructure | Commit / range | Tag | Production ready | Purpose |
| --- | --- | --- | --- | --- |
| Core regression baseline | `e7358a4` | `checkpoint-core-regression-baseline-20260812` | **NO** | Fixed Local fixtures and diagnostics |
| Test Sandbox Phase A | `214f4d5` | `checkpoint-test-sandbox-phase-a-before-a2` | **NO** | Test provider mode, isolated Test DB, initial guard/UI |
| Test Sandbox Phase A2 | `b6e16d2` and later Test-only commits | `checkpoint-test-sandbox-phase-a2-before-production-sync-20260815` | **NO** | Test Owner, fail-closed network guard, Test storage isolation |
| Production-to-Test code alignment | `93b69ab` | — | **NO** | Keeps Test behavior aligned with Production without reversing direction |
| Test regression alignment | `d907ea1` | `checkpoint-test-sandbox-before-json-import-20260815` | **NO** | Test-only proxy-agent regression behavior |
| Production JSON snapshot importer | `084a2ebf8fedec0d9d66d8ba35c19e4b555bca9f` | `test-infra-snapshot-import-only` | **NO — TEST INFRA ONLY** | Atomic import into `daigou-erp-db-test-v1` |

These nodes may include `Test Owner`, `TestSandboxProvider`, `daigou-erp-db-test-v1`, namespaced Test localStorage, Supabase Network Guard, snapshot import, and Sandbox tests. None may be included in a Production release.

## Required release flow

### Releasing one feature

1. Fetch and verify the latest `origin/main`.
2. Create a clean `codex/release-<feature>` branch from that exact commit.
3. Cherry-pick the feature’s single final commit from this registry.
4. Review the complete diff against `origin/main` and scan for Test infrastructure.
5. Run Build, TypeScript, core regression, targeted tests, and `git diff --check`.
6. Complete local and Preview acceptance.
7. Wait for explicit Production approval.
8. Create a Production backup tag, then push/deploy code only.

### Releasing Features A and B together

Cherry-pick in this order:

1. `b0673caab80f33a5ef2246f7fb9c546a19c737b1`
2. `24cc27aac6f126470a8bc695d7b5b8a0e7924187`

The commits do not depend on one another, but this order keeps the registry order clear.

## Checklist for future Test Sandbox features

- [ ] One feature only in the commit.
- [ ] No unrelated refactor.
- [ ] Read/write behavior documented.
- [ ] Schema and Provider impact documented.
- [ ] Dependencies explicitly listed.
- [ ] Targeted tests included.
- [ ] Core regression passes.
- [ ] Final squashed feature node created when development used multiple commits.
- [ ] Readiness tag created locally.
- [ ] Production release is performed from a clean latest-Production branch, never by merging Test Sandbox.

## Unattended validation audit — 2026-08-17

The dual-Sandbox unattended run validated the existing selected features and
recorded them as `Implementation Passed / Awaiting Manual Acceptance` or
`Field Testing` only. No item was promoted to `Accepted` by automation.

| Area | Status | Evidence / limitation |
| --- | --- | --- |
| Dual Sandbox parity and lifecycle | Implementation Passed / Awaiting Manual Acceptance | `test:dual-sandbox`, `test:sandbox-snapshot-parity`, `test:dual-sandbox-lifecycle`; persistent browser import/clear/re-import still needs operator SOP |
| Outbound receiving P0 race | Implementation Passed / Awaiting Manual Acceptance | `tests/outbound-receiving-save-race.mjs`; serial queue, pending navigation/F5 and failure paths passed |
| Purchase Management / Recent Purchases | Implementation Passed / Awaiting Manual Acceptance | targeted action, ledger and recent-purchases checks passed; no data writes |
| Japan Package bundle display | Field Testing | Existing Registry behavior reviewed; fresh full visual sweep remains for manual acceptance |
| P0-A / P0-B / P0-F | Implementation Passed / Awaiting Manual Acceptance | maintained atomic import, cloud restore fail-closed and bootstrap boundary checks passed; manual SOP required |
| P0-C / P0-D / P0-E | Design Gate | no front-end compensation or partial-write workaround attempted |
| PurchaseRecords performance | Analysis Only | benchmark variance did not prove a stable optimization; no code changed |
| Product/Variant import performance | Analysis Only | parser ~38 ms; verification/transaction/readback dominate; no code changed |
| Stability Audit v3 | Implementation Passed / Awaiting Manual Acceptance | report: `docs/system-stability-audit-v3.md`; findings remain analysis-only |

The unattended run did not add a new Production-ready feature, did not alter
the Feature Registry's existing Production decisions, and did not push or
deploy either Sandbox.

## Extended stability health review — 2026-08-18

This review updates evidence status only. It does not promote any feature to
Production Ready and does not replace the feature commits/tags above.

| Area | Evidence | Current status | Production Ready |
| --- | --- | --- | --- |
| P0-G Variant destructive-sync guard | Production-like `b50a0a4`; normal sync, Variant read failure, zero-write assertion, VSPO Golden and orphan checks | **Accepted** by prior manual SOP; extended automated verification passed | **NO — separate Production hotfix approval still required** |
| Next raw snapshot integrity | `test:next-nightly-integrity`; 16 collections, counts/hashes, Golden VSPO and source orphan parity | **Automated Tested** | NO |
| Next read-only route/F5 stability | `test:next-readonly-soak`; 10 rounds, 60 routes, 10 reloads, checksum unchanged | **Automated Tested / Awaiting Manual Acceptance** | NO |
| Read Failure Matrix | `docs/next-read-failure-matrix-20260818.md`; 7 collection fault probes plus Variant sync gate | **Analysis Complete**; C-class paths remain open | NO |
| Atomic import harness | `test:atomic-import-data` on neutral port 4253 | **Automated Tested** | NO |
| Existing user-facing Features A/B/C/C2/E/F/G | Existing targeted tests plus cross-route read-only review | **Field Testing**; no new manual acceptance inferred | NO |

The new commits in this extended run are test/documentation infrastructure or
stability evidence only. They must not be cherry-picked into a Production
release. Any Production release still starts from current `origin/main` and
selects only the explicitly approved clean feature/hotfix node.
