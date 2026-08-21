# Closing Date Workbench Migration 4 — Next-only Workbench UI

Status: **Implemented + Automated Tested / Awaiting Manual Acceptance**

Base: `checkpoint-20260821-0806-closing-date-batch-gateway-awaiting-workbench-ui`

## Scope and safety boundary

- The entry point is shown only when both the immutable build role and active
  provider role are `next`, and the Next-only UI feature flag is enabled.
- Production, Cloud, Local, Test, and Experimental builds do not render the
  Workbench.
- `PurchaseRecords` loads the Workbench through `React.lazy`; Sidecar storage,
  Gateway, Catalog snapshot, and polling are not initialized before the user
  opens it.
- Analysis writes only Resolution Batch/Result/Candidate data to the Next
  Sidecar. It does not write `ProductGroup`.
- Parser/fuzzy evidence remains YELLOW even at 100%. GREEN is assigned only by
  the Domain/Gateway contracts for active Verified Mapping or exact identity
  evidence.
- RED results have no selectable candidate and cannot be applied.
- “選擇並記住” creates only a supplier-scoped Verified Mapping. It does not
  change `closing_date`.
- Closing the Workbench unmounts the UI and clears its polling timer. A local
  Batch runner may finish independently; after a page reload, an active status
  with no runner is changed to `FAILED / RUNNER_INTERRUPTED / retryable` rather
  than remaining stuck forever.
- Final apply bypasses `IDataProvider` and Supabase and opens only a database
  whose name starts with `daigou-erp-db-next-v1`. It performs all stale checks
  again inside one IndexedDB read/write transaction and performs one
  ProductGroup-array `put`. Any missing/stale product or changed
  `closing_date` makes the whole Batch `CONFLICT` with zero ProductGroup write.
- Apply Audit is durably created before the main transaction and finalized in
  the Sidecar afterward. A post-commit audit-finalization failure is reported
  explicitly and is never mislabeled as a ProductGroup rollback.

## UI flow

```text
PurchaseRecords selection
  -> 分析結單日
  -> Batch progress / cancel / retry
  -> GREEN / YELLOW / RED review
  -> YELLOW Top 3 selection
  -> optional 選擇並記住
  -> final confirmation
  -> Next-only atomic apply
```

Completed Batches can be reopened from the Sidecar after F5. The Workbench does
not pretend to resume a runner that no longer exists.

## Automated verification

| Gate | Result |
| --- | --- |
| `npm run build:next` / TypeScript | PASS |
| `npm run test:closing-date-workbench-ui` | PASS |
| Domain / Sidecar / Batch Gateway dedicated tests | PASS |
| `npm run test:core` | PASS |
| `npm run test:sandbox-guard` | PASS |
| `npm run test:sandbox-architecture` | PASS |
| `npm run test:next-nightly-integrity` | PASS |
| Variant destructive-sync guard / atomic import regression | PASS |
| `git diff --check` | PASS |

The dedicated Workbench test proves:

- analysis main-DB writes: 0;
- choose-and-remember main-DB writes: 0;
- GREEN/YELLOW/RED rendering: 1/1/1;
- completed-review reload, cancel, and retry;
- apply changes only `closing_date` and retains every other ProductGroup field;
- duplicate idempotency submission does not create a second logical apply;
- stale conflict: `CONFLICT`, zero write;
- fault after the ProductGroup `put`, before commit: transaction rollback and
  zero write;
- active job with missing runner: `FAILED`, retryable;
- Production Supabase requests: 0.

## Deterministic Gateway benchmark

This benchmark uses controlled public-Catalog-shaped responses so Gateway
overhead, query dedupe, cache, single-flight, and concurrency can be compared
without upstream latency variance.

| Batch | Cold total | Cold p50 / p95 | Cold upstream | Warm total | Warm upstream |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 140.7 ms | 92.4 / 108.3 ms | 33 | 3.5 ms | 0 |
| 50 | 281.4 ms | 30.6 / 95.2 ms | 93 | 18.5 ms | 0 |
| 100 | 473.7 ms | 32.9 / 93.6 ms | 168 | 36.8 ms | 0 |

## Real 4192 Browser field test

Date: 2026-08-21, Next Sandbox, public read-only Catalog gateway. No final apply
was clicked against the existing Next data.

| Batch | Gateway-reported total | Upstream | Cache | Dedupe | Review result |
| ---: | ---: | ---: | ---: | ---: | --- |
| 10 cold | 57.072 s | 75 | 1% | 4% | 9 YELLOW / 1 RED |
| 50 mixed | 187.488 s | 321 | 4% | 4% | 26 YELLOW / 24 RED |
| 100 mixed | 329.503 s | 615 | 7% | 7% | 68 YELLOW / 32 RED |
| 10 after one Verified Mapping | 50.626 s | 75 | 1% | 4% | 1 GREEN / 8 YELLOW / 1 RED |
| immediate repeat of same 10 | 0.288 s | **0** | 100% | 100% | same classifications |

The real cold batches contain mostly unrelated product titles, so cross-item
query overlap is low. Concurrency substantially reduces elapsed time and an
immediate warm repeat uses zero upstream requests, but the cold request counts
remain high because many generated queries are unique. This is recorded as a
future Gateway/query-coverage performance observation; Migration 4 does not
change Retrieval, Matching, threshold, ambiguity guard, or Supplier Priority.

Browser acceptance also verified:

- Top 3 selection works;
- “選擇並記住” created one Next Sidecar mapping for the confirmed
  `SMP 百獸戰隊牙吠連者 牙吠獵人(再販)` candidate and changed no ProductGroup;
- F5 reopens a completed review;
- cancel followed by retry completes;
- F5 during RUNNING shows `已中斷，可重試`;
- Workbench Console errors/warnings: 0.

## PurchaseRecords unopened performance

The Workbench chunk is absent from resource entries before opening it. Compared
with the Migration 3 baseline, the measured search-100 and sort-25 workloads
changed by approximately +1.1% and +0.8%; route switching improved by about
0.7%. These are within run-to-run variation. A repeated reload aggregate was
noisy (+18%), while individual initial reload and first render were faster; no
material normal-table regression was reproduced.

## Data integrity

Final `test:next-nightly-integrity` results:

- Groups 559; Categories 305; Variants 2438; Inventory 4096;
- Purchase Batches 467; Purchase Batch Items 1407;
- Private Orders 93; Private Order Items 120; Bundle Components 284;
- Japan Packages 36; Japan Package Items 225;
- Outbound Shipments 9; Outbound Shipment Items 210;
- all source/Next collection hashes equal;
- all recorded orphan counts unchanged;
- Golden VSPO WACA/purchased remains `4/9, 0/0, 3/19, 0/2, 2/13`;
- Production IndexedDB unchanged;
- Production Supabase requests: 0.

## Manual acceptance focus

1. Open `http://127.0.0.1:4192/purchase-records` and select products.
2. Open `分析結單日`; confirm the saved 10-item Review shows 1 GREEN, 8
   YELLOW, and 1 RED.
3. Inspect YELLOW Top 3 candidates. A radio selection alone is temporary;
   `選擇並記住` must report that no closing date has yet changed.
4. Close/reopen the Workbench and inspect recent completed and interrupted
   Batches.
5. Use a disposable Next test item for final Apply if desired. A stale
   `updated_at` or changed `closing_date` must show a conflict and leave the
   whole Batch unchanged.

Migration 5, Cloud RPC/API, Supabase storage, Production integration, Push, and
Deploy are explicitly out of scope.
