# Closing Date Workbench Migration 3 — Next-only Read-only Batch Gateway

Status: **Implemented + Automated/Performance Tested / Workbench UI Not Started**

This stage adds a Next-only TypeScript batch service and polling contract. It is
disabled by default and is not imported by the current ERP UI. Migration 4 is
responsible for any Workbench UI integration.

## Boundary

- Build gate: immutable `next` build mode plus
  `VITE_ENABLE_CLOSING_DATE_BATCH_GATEWAY=true`.
- Catalog access: read-only `GET /api/catalog/search` through the existing
  read-only Catalog client.
- Persistence: only the six existing Migration 2 stores in
  `daigou-erp-closing-date-sidecar-next-v1`.
- ERP writes: none. The gateway has no Provider, main IndexedDB, Supabase, or
  `ProductGroup.closing_date` write dependency.
- Schema: no ProductGroup, Sidecar store, Supabase, backup, or snapshot-format
  migration was added.

## Implemented contracts

- Job create, poll, cancel, retry, and wait-for-completion.
- Idempotent logical batch creation. A repeated idempotency key returns the
  original job even after the current Catalog snapshot version rolls over.
- TTL query cache keyed by Catalog snapshot version, page size, and normalized
  query.
- Single-flight sharing for identical concurrent queries.
- Bounded upstream concurrency (default 6) and bounded item concurrency
  (default 6).
- Progressive persistence of each Result and Top 3 Candidate set. Batch
  progress + Result + Candidate writes use one Sidecar IndexedDB transaction.
- Retry is limited to retryable service-error items. Cancellation stops new
  item/query scheduling and preserves already committed Sidecar diagnostics.
- All parser/fuzzy inferred candidates remain `YELLOW`; this stage does not
  promote them to auto-apply `GREEN` and does not apply a closing date.

The current local Catalog snapshot is a pinned TTL cache version, not a remote
immutable Catalog database revision. Every query in a batch is checked against
the pinned version contract. A future Cloud implementation would need a real
server-owned snapshot revision; this stage does not create or access Cloud
resources.

## Controlled 10 / 50 / 100 benchmark

Method: the real Gateway, query cache, polling path, and IndexedDB Sidecar
repository were exercised in Chromium against a deterministic local read-only
Catalog fixture with 15 ms latency per upstream request. This isolates the
waterfall/dedupe/concurrency behavior and is not a claim about public Internet
latency or Catalog Worker SLA.

Configuration: max upstream concurrency 6; max item concurrency 8. Each size
was run cold, then warm against the same snapshot/cache.

The existing live read-only proxy availability gate was also run from a local
process with outbound permission: Catalog search, Hololive, and VSPO endpoints
all returned HTTP 200, while the 502 fail-closed path performed no JSON parse or
write. The deterministic benchmark below intentionally does not depend on that
external service.

| Items | Cache | Total ms | Item p50 ms | Item p95 ms | Logical queries | Upstream requests | Dedupe ratio | Cache hit ratio | Peak upstream |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | cold | 144.9 | 94.6 | 110.8 | 55 | 33 | 40% | 11% | 6 |
| 10 | warm | 5.6 | 0.2 | 0.2 | 55 | 0 | 100% | 100% | 0 |
| 50 | cold | 289.8 | 30.5 | 96.5 | 275 | 93 | 66% | 60% | 6 |
| 50 | warm | 31.2 | 0.1 | 0.2 | 275 | 0 | 100% | 100% | 0 |
| 100 | cold | 478.7 | 30.4 | 95.6 | 550 | 168 | 69% | 67% | 6 |
| 100 | warm | 67.4 | 0.1 | 0.2 | 550 | 0 | 100% | 100% | 0 |

The historical 10-item observation of about 125 seconds came from live
sequential Catalog traffic and is not directly comparable to the controlled
15 ms fixture. The reproducible result here is that 55 logical lookups become
33 cold upstream requests and 0 warm upstream requests, with a measured peak
of 6 rather than a serial waterfall.

## Cancellation, retry, and failure gates

- Cancellation fixture: 40 requested items; job reached `CANCELLED`; no request
  was added after cancellation; cancellation metric = 1.
- Service failure fixture: result classified `RED`, retryable count = 1;
  retry attempt 2 completed and produced a `YELLOW` diagnostic result.
- Partial service failure remains `RED` even when another query returned a
  candidate; an incomplete retrieval is never presented as a successful
  analysis.
- Mapping read failure: job creation rejected before persistence; all six
  Sidecar stores remained empty.
- Candidate-write fault injection: job became `FAILED`; completed progress = 0;
  Result rows = 0 and Candidate rows = 0. The transaction rolled back.
- Duplicate idempotency key after snapshot rollover: original job ID returned;
  no second snapshot open and no second logical batch.

## Data-integrity gate

The post-implementation Next integrity probe remained identical to the fixed
snapshot baseline:

- Product Groups: 559
- Product Variants: 2438
- Purchase Batches: 467
- Purchase Batch Items: 1407
- all collection hashes equal
- Golden VSPO WACA: `4 / 3 / 0 / 0 / 2`
- Golden VSPO purchased: `9 / 19 / 0 / 2 / 13`
- every historical orphan count unchanged
- Production IndexedDB unchanged
- Production Supabase requests: 0

## Deliberately not implemented

- Workbench UI or PurchaseRecords integration
- `ProductGroup.closing_date` apply
- HTTP/Cloud job endpoint, SSE, or Production runtime
- Supabase table, RPC, migration, or provider integration
- Parser/Matching/threshold/ambiguity/Supplier Priority changes
- Import binding, backup format upgrade, or Catalog Worker deployment
