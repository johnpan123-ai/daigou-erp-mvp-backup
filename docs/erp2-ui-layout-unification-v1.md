# ERP 2.0 UI layout unification v1

## Baseline and recovery

- Latest remote-proven accepted baseline: `e565d067f49c95cf71dd6c95c5fab5b4749558f8`.
- Recovery tag: `backup-20260927-before-erp2-ui-layout-unification-v1`, remotely verified at that accepted SHA before source edits.
- Live runtime: `68269ad9e80762c07d64fde38194a56e3db69e1f`, deployment `ce6b0083-d0d7-412c-85dc-32d5be4b8ebb`. Its clipboard live readback acceptance remains incomplete; this task does not promote its acceptance status.
- Implementation parent: `151fe2fd1fd07ec168affa72c7a27ee785c38fb6`, preserving the Quick Wins runtime and the subsequent accepted-lineage deployment guard.

## Layout inventory

The application adds 32px horizontal padding, while several pages add another 16–32px. Page limits differ: Dashboard 1420px, Recent Purchases 1500px, Japan Packages 1800px, Outbound 900px, Duplicate Variants 1100px. Purchasing has a full-width outer container but a 760px inner list. Inventory and Unlisted Items already allow full width. Japan's empty state uses a centered 540px panel and 40px outer margin. These are presentation constraints, independent of data and workflow state.

The shared layout owns page padding once, with full-width content, reusable header/toolbar/stats/content shells, and bounded empty-state spacing. Existing data selectors, handlers, providers and request contracts stay intact.

## Shared presentation contract

- `src/components/layout/PageHeader.tsx`: shared by all nine pages. Left aligned title/description and wrapping actions; page owns its original handlers.
- `src/styles/workspace.css`: opt-in page, stats, toolbar, content/panel, empty, two-line title and nonshrinking action primitives. Existing colors/radii/shadows are reused.
- Only the nine exact list routes opt out of AppLayout's old padding. Sidebar, Settings, authentication and detail-route layout stay unchanged.
- One 24px inset at desktop, 16px at mobile. Inner work area is 1110px at 1366, 1024px at 1280, 358px at 390 with the existing sidebar.
- Stats stretch equally within a row, desktop uses available width, mobile wraps. Table column widths/resizers remain page-owned; local table scrolling is allowed, page overflow is not.
- `EmptyState` adds an opt-in compact variant. Existing other callers keep their original behavior.
- Purchasing no longer has a 760px inner cap or a centered/dark oversized header. Its refresh control is placed with the shared left-aligned header without changing its callback/resources.
- Purchasing/Recent Purchases/Dashboard/Unlisted/Duplicate titles use the shared two-line ellipsis rule. Inventory and Purchase Records retain their existing two-line behavior. Full title values/search inputs/copy values are unchanged. Purchasing action width and x position are tested against both extremely long and short fixture text.

## Nine-page geometry evidence

Before widths below are usable inner widths, not viewport widths. Purchasing's old inner cap is accounted for. All after widths are full available work areas, not edge-to-edge content.

| Page | Before 1366 / 1280 / 390 | After 1366 / 1280 / 390 | Verification |
| --- | --- | --- | --- |
| Dashboard | 1038 / 952 / 330 | 1110 / 1024 / 358 | Left header, stats wrap, queue shell, empty queue |
| Inventory | 1094 / 1008 / 358 | 1110 / 1024 / 358 | Six stats, toolbar, empty and populated long-title table |
| Purchase Records | 1094 / 1008 / 358 | 1110 / 1024 / 358 | Existing table/mobile cards, filters, compact empty |
| Recent Purchases | 1094 / 1008 / 358 | 1110 / 1024 / 358 | Full-width date sections, local table scroll, no-result state |
| Purchasing | 760 / 760 / 326 | 1110 / 1024 / 358 | Shared left-aligned header, two-line title, fixed action column |
| Japan Packages | 1046 / 960 / 310 | 1110 / 1024 / 358 | Stats/filter/list, mobile controls, compact empty |
| Outbound | 836 / 836 / 326 | 1110 / 1024 / 358 | Header, list, search/status controls, empty shell |
| Pending Delist | 1094 / 1008 / 358 | 1110 / 1024 / 358 | Stats/filter/list, preserved canonical-ID deep link |
| Duplicate Variants | 1062 / 976 / 326 | 1110 / 1024 / 358 | Summary cards, full-width candidate/empty shell |

`npm run test:ui-layout` runs source preservation plus 27 true-App fixture geometries at 1366/1280/390. Assertions cover full workspace width, symmetric insets, left header, equal-height same-row stats, content bounds, no document/main overflow, compact empty state, exactly preserved event handlers and zero fixture write calls.

Evidence is in `scratch/ui-layout-evidence/`: `before/` (27 original screenshots and geometry), `after/` (27 screenshots, empty-state screenshots, populated Inventory screenshots and geometry), plus regression logs. These are **isolated browser fixtures**, not Live screenshots. Their EXPERIMENTAL banner is the existing safe harness identity; the release artifact is STAGING. Long artificial names exist only in disposable test data/DOM, not source product names, persisted data or Live UI. Test network interception blocks all non-local requests.

## Regression matrix

PASS: TypeScript; changed-line ESLint (zero new errors/warnings/findings; inherited baseline 92 errors/9 warnings retained); diff whitespace check.

PASS: workflow Quick Wins title parity, deep-link F5/back/forward/invalid ID, clipboard success/failure and 44px mobile button; mounted-content stability; mutation-layout stability; Japan confirmation flicker; partial receiving/outbound route; outbound receiving race; agency quantity patch; unlisted demand; growth-safe selector/business-result equivalence.

PASS: Realtime/Draft catch-up; Manual Authoritative Refresh; Purchase Records edit view; Deadline V1 integration; canonical Deadline/Restore source preservation; durable execution closure; proof-backed dispatch boundary (269-byte EXECUTE); Restore final closure source/model checks; deployment identity guard (38 cases).

Restore SQL was not applied/reexecuted. Existing tests that require a new real PostgreSQL apply retain their explicit pending classification; this is a presentation-only change and all migration/provider/Restore source is byte-identical to the integration parent.

## Delivery and safety

Feature branch: `codex/erp2-ui-layout-unification-v1`.
Delivery checkpoint: `checkpoint-20260927-erp2-ui-layout-unification-v1`.
Recovery and accepted tags are not moved. Commit messages use `[CF-Pages-Skip]` to avoid unrelated ERP 1.0 preview builds. Push occurs only for the completed branch/checkpoint, not intermediate batches.

STAGING build target: `rhfdjsklfrgpoqsaqpkn`; approved public fingerprint: `D9EA6B7BB6524517`. Final artifact/source identity is recorded in `staging-release-artifacts/frontend-manifest.json` after the final source commit.

Business logic, provider, models, SQL, Restore 041/042/043, Deadline query/ranking/apply, environment guard, Catalog and fixtures are unchanged. Live write / Deploy / Restore / SQL / Migration = 0. No WACA work. No NEXT/Experimental worktree modifications. This task does not claim Live acceptance and does not create a new accepted-live tag.
