# ERP System Stability Audit v3 — 2026-08-17

Timezone: Asia/Taipei (UTC+8)

## Scope and safety boundary

This audit covers the Next and Experimental local Sandboxes only. No
Production Supabase write, migration, restore, import, local-to-cloud push,
main push, or deployment was performed. Browser tests use Test/Sandbox
IndexedDB and assert zero Production Supabase requests where applicable.

Manual acceptance is not implied by automated results. Any stage that has not
been manually exercised by the operator remains `Implementation Passed /
Awaiting Manual Acceptance`.

## Verification summary

| Area | Result | Evidence |
| --- | --- | --- |
| Next build / TypeScript | Passed | `npm run build:next` |
| Experimental build / TypeScript | Passed | `npm run build:experimental` |
| Core regression | Passed in both | `npm run test:core`; fixed fixture values and proxy-map regression unchanged |
| Test Owner | Passed | `npm run test:test-owner-auth` |
| Sandbox architecture | Passed | `npm run test:sandbox-architecture` |
| Fail-closed network guard | Passed | `npm run test:sandbox-guard`; REST/Auth/RPC/Storage/Functions/XHR/beacon/WebSocket/client paths blocked |
| Snapshot import | Passed | `npm run test:test-snapshot-import`; validation, atomic rollback, readback and Production sentinels |
| Dual Sandbox parity | Passed | `npm run test:dual-sandbox`, `npm run test:sandbox-snapshot-parity` |
| Dual Sandbox lifecycle | Passed | `npm run test:dual-sandbox-lifecycle`; independent import, F5, clear and re-import |
| Outbound receiving P0 race | Passed | `node tests/outbound-receiving-save-race.mjs` |
| Inventory backup gate | Passed | `node tests/inventory-backup-gate.mjs` |
| Outbound export | Passed | `node tests/outbound-purchase-cost-export.mjs` |
| Recent Purchases | Passed | `node tests/recent-purchases.mjs` |
| Purchase Management actions | Passed | `node tests/purchase-management-actions.mjs` |
| Cloud restore stop-gap | Passed | `node tests/cloud-restore-fail-closed.mjs` |
| Bootstrap failure boundary | Passed | `node tests/bootstrap-error-boundary.mjs` |
| Full ESLint | Failed on existing backlog | 627 problems (580 errors, 47 warnings), including backup directories; not changed in this audit |

## P0 data-loss / data-pollution risks

No new P0 data-loss path was proven in this audit.

The existing P0-C, P0-D and P0-E design gates remain blocked and unchanged:

- P0-C: purchase batch header and items are not one server-side transaction.
- P0-D: Inventory import and PurchaseRecords synchronization are separate
  multi-step writes.
- P0-E: outbound shipment header and item deletion are separate writes.

They were not repaired with front-end compensation and were not marked
Accepted.

## P0 crash / blank-screen risks

No new crash was found. P0-F bootstrap failure recovery remains covered by the
Test-only failure injection and renders a recovery screen instead of a blank
page.

## P1 state and error risks

### P1-1 — page-level fetch failures can become empty collections

- Location: `src/pages/Purchasing.tsx:308-317`.
- Location: `src/pages/JapanPackageDetail.tsx:477-482`.
- Location: `src/pages/PurchaseManagement.tsx:1139`.
- Behavior: individual reads use `.catch(() => [])`; a failed read can be
  indistinguishable from a legitimate empty collection.
- Impact: purchase summaries, bundle candidates, or package metadata can look
  incomplete without an explicit Error state. This is primarily a state/UI
  integrity risk; it must not be fixed by changing business formulas.
- Suggested minimum fix: return a typed load error alongside the collection,
  preserve the previous state, and render Loading / Empty / Error separately.
- Provider/db/schema impact: none required for the UI-only first step.
- Status: analysis only; no code changed.

### P1-2 — PurchaseRecords fresh-load rejection is not surfaced

- Location: `src/pages/PurchaseRecords.tsx:1200-1210`.
- Behavior: the cached preview may render, `loadFreshData()` is awaited inside
  `try/finally` without a catch, and the effect invokes `loadData()` without
  awaiting it. Flags are cleared, but a rejected fresh load can become an
  unhandled rejection with no page-level Error state.
- Impact: stale values may remain visible while the user receives no clear
  explanation that the refresh failed.
- Suggested minimum fix: catch at the effect boundary, preserve the cached
  state, and show a non-destructive refresh error with retry.
- Provider/db/schema impact: none required for the UI-only first step.
- Status: analysis only; no code changed.

### P1-3 — IndexedDB read/write fallback can hide storage failure

- Location: `src/lib/db.ts:2013-2084`.
- Behavior: a read error falls back to localStorage or a default empty array;
  a write error falls back to localStorage.
- Impact: browser storage failure can look like missing data or split the
  authoritative store between IndexedDB and localStorage. This is a data
  reliability risk, but no live failure was injected in this audit.
- Suggested minimum fix: expose a typed storage error state and require an
  explicit retry/backup decision before treating a failed read as empty.
- Provider/db/schema impact: likely db.ts; requires a separate approved stage.
- Status: analysis only; no code changed.

## P1 race / write observations

- Outbound checked/checked_at is protected by the existing serial save queue;
  rapid 10-item, immediate F5, navigation, same-SKU source-item, toggle-back,
  and failure tests passed. The UI still calls the queue through `void`, but the
  queue owns awaiting, failure state, and navigation protection. This remains a
  regression surface, not a newly proven failure.
- Dashboard image save is intentionally fire-and-forget at
  `src/pages/Dashboard.tsx:159`, but it attaches a rejection handler and keeps
  the prior image on failure. Classify as P2 observability rather than P0.
- Existing multi-step purchase batch and inventory sync writes remain under
  P0-C/P0-D design gates; no new write was attempted.

## P2 UX / observability

### P2-1 — backup/legacy page has empty fallbacks

`src/pages/Dashboard_backup.tsx:28-34` uses empty-array fallbacks. The file is
legacy/backup code rather than the active Dashboard route, but it can mislead a
future maintainer and should be removed or explicitly marked non-runtime in a
separate cleanup.

### P2-2 — missing named test entry

The feature test `tests/recent-purchases.mjs` passes when run directly, but the
package does not currently expose `npm run test:recent-purchases`. This is a
test discoverability problem, not an ERP data problem.

### P2-3 — ESLint backlog

`npm run lint` currently reports 627 existing problems, including backup
directories and pre-existing `any`/hook-order issues. Build and TypeScript
remain green; lint cleanup is intentionally outside this audit.

### P2-4 — short-lived UI timers

Several 220ms/short toast timers are not all represented by explicit unmount
cleanup (`JapanPackagesList`, some transient UI actions). They are low-risk,
short-lived UI effects; no listener/timer growth was observed in the bounded
Sandbox checks.

## Date consistency

The prior date audit remains applicable; no date rule was changed here.

- `PurchaseRecords` and Dashboard use normalized full dates for closing-state
  decisions.
- `YYYY-MM-DD` and `YYYY/MM/DD` are supported in the main normalization path.
- `MM/DD`, free-form `未定`, and blank values do not have one universal meaning
  across all pages; Recent Purchases has a timestamp fallback for batch dates,
  while closing-state pages treat invalid/blank closing dates as no closing
  date.
- `YYYY年MM月` and 上旬／中旬／下旬 are release-month display/sorting inputs,
  not closing-date values. They must not be used to silently change status.

This remains a consistency backlog item, not an automatically applied formula
change.

## Import / backup

- Test Snapshot import: atomic transaction, validation before write, checksum
  readback and rollback passed.
- Inventory XLS import: pre-import JSON backup gate, non-empty/parseable backup,
  failure abort and preservation passed.
- Cloud restore: UI disabled and provider fail-closed before any Supabase write;
  Local/Test restore remains available and atomic.
- The older `tests/atomic-import-data.mjs` entry currently assumes that a
  server on port 4193 can select legacy `test` mode. Dual Sandbox port 4193
  intentionally owns `experimental` mode, so this old harness read the wrong
  DB and failed at its baseline assertion. This is a test-harness compatibility
  issue, not evidence that the atomic importer corrupted data. The maintained
  `test-snapshot-import` suite passed the same atomic validation/rollback
  requirements.

## Performance

Fixed Snapshot: `workbench-backup-2026-08-15.json`.

| Measurement | Next | Experimental |
| --- | ---: | ---: |
| Snapshot import total | 22,803 ms | 33,393 ms |
| PurchaseRecords first load | 1,464 ms | 3,560 ms |
| PurchaseRecords reload | 1,323 ms | 3,074 ms |
| 100 searches | 11,672 ms | 18,311 ms |
| 25 sorts | 3,044 ms | 3,039 ms |
| Category switch | 164 ms | 260 ms |
| 1,300-row XLS parser | 38 ms | 38 ms |
| Production Supabase requests | 0 | 0 |

The two environments use the same source but show large variance, so no
stable Before/After optimization claim is justified. PurchaseRecords already
uses `useDeferredValue`, search/index `useMemo`, grouped maps, and memoized
derived lists. A safe Phase 1 experiment would need an isolated benchmark and
must not change table structure, filtering, sorting, or business calculations;
no code change was made in this audit.

Snapshot import is dominated by browser-side verification work rather than XLS
parsing: JSON decoding/shape validation, stable JSON serialization and SHA-256
for 15 collections, one atomic IndexedDB transaction, then full readback and
per-collection checksum verification. The parser benchmark is only ~38 ms, so
optimizing parser string matching would not address the observed wait. Any
future optimization must preserve the transaction and verification gates.

## Sandbox isolation

Passed:

- Next DB: `daigou-erp-db-next-v1`, port 4192, namespace
  `__hippo_next_sandbox__::`.
- Experimental DB: `daigou-erp-db-experimental-v1`, port 4193, namespace
  `__hippo_experimental_sandbox__::`.
- Independent clear/reload/re-import does not cross the two databases.
- Production physical IndexedDB remains unchanged in lifecycle/import tests.
- Production Supabase request count remains zero.
- Test Owner/Auth paths are local in Sandbox; Production Auth is not used by
  these tests.

## Recommended next order

1. Keep P0-C/D/E at Design Gate until server-side atomic boundaries are
   approved; do not use front-end compensation.
2. Fix P1-1/P1-2 Error-vs-Empty handling without changing formulas.
3. Decide the storage fallback policy for P1-3 before touching `db.ts`.
4. Add a dedicated named `test:recent-purchases` script and repair the legacy
   atomic-import test entry so it explicitly selects a test-mode port.
5. Only then consider a separately benchmarked PurchaseRecords rendering
   optimization.

No implementation changes were made for the findings in this report.
