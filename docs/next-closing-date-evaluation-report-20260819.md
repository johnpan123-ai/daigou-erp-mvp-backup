# Next Closing Date Matching Evaluation Report

## Status

**Evaluation Harness Implemented / Matching v2 Not Started**

This report is for the Next Sandbox only. It does not promote the feature to Production Ready.

## Harness architecture

The evaluation is split into two explicit stages:

1. **Capture:** `capture:closing-date-fixtures` performs read-only `GET` requests to the configured Catalog gateway and stores only the ERP title, attempted queries, response status, and the necessary candidate identity/supplier/deadline fields in `tests/fixtures/closing-date/dataset.json`. It never reads ERP IndexedDB and never calls a Provider.
2. **Offline replay:** `test:closing-date-evaluation` loads the saved candidates into the existing Product Identity / Supplier Selection functions. It does not call Catalog, Supabase, IndexedDB, or any Provider. The test fails if an `/api/` or Supabase request is observed.

Existing fixtures are reused by default. `--refresh` is required to recapture a query, and `--write` is required before the capture utility may update the test fixture file.

## Evaluation result

| Case | Result | Evidence |
| --- | --- | --- |
| figma 路西法 | PASS | `FIGMA` + 路西法 → `figma 路西法`; raw `2026-09-18`; suggested `2026-09-16` |
| POP UP PARADE 橘雪莉 L Size | PASS | `POP_UP_PARADE` + 橘雪莉 + size metadata `L`; raw `2026-09-18`; suggested `2026-09-16` |
| 峰月律 Wanrong priority | PASS | same identity listings select `wanrong`; raw `2026-09-07`; suggested `2026-09-05` |
| NENDOROID vs SCALE_FIGURE | PASS | hard Product Type conflict → `NOT_FOUND`, zero-write candidate |
| POP_UP_PARADE vs NENDOROID | PASS | hard Product Type conflict → `NOT_FOUND`, zero-write candidate |
| Same Product Type, different character | PASS | identity token missing → `NOT_FOUND` |
| SEGA Yumemirize 若葉睦 | KNOWN FAILURE | current retrieval fixture has no candidate; expected source raw deadline is recorded as `2026-08-27`, suggested `2026-08-25`; no matching change was attempted |
| SEGA Yumemirize 豐川祥子 | KNOWN FAILURE | current retrieval fixture has no candidate; expected source raw deadline is recorded as `2026-08-27`, suggested `2026-08-25`; no matching change was attempted |

Summary: **8 total / 6 PASS / 2 KNOWN FAILURE / 0 REGRESSION / 0 AMBIGUOUS**.

The known failures are intentionally not converted to passing assertions. They are retrieval samples for the future Product Line / Manufacturer evaluation and are not character-specific workarounds.

## Debug fields available during manual field test

After `🔍 自動查詢結單日`, the page exposes a read-only `最近一次結單日查詢診斷` panel containing:

- original ERP title
- `MATCH`, `AMBIGUOUS`, `NOT_FOUND`, or `SERVICE_ERROR`
- score and reason
- ERP Product Type, identity, series, size, and manufacturer
- selected Catalog title and candidate normalization
- supplier
- raw deadline
- final ERP closing date after the existing business rule
- alternative candidates for ambiguous / rejected results

This panel is React state only and does not add a schema field or write a diagnostic record.

## Automated gate

- `npm run build:next` — PASS
- `npm run test:closing-date-evaluation` — PASS; offline replay, 0 Catalog/Supabase requests
- `npm run test:proxy-product-identity` — PASS
- `npm run test:catalog-api-availability` — PASS when run with public upstream network access
- `npm run test:core` — PASS
- `npm run test:sandbox-guard` — PASS; Production Supabase request 0
- `npm run test:sandbox-architecture` — PASS
- `git diff --check` — no whitespace errors; existing CRLF normalization warnings only
- `npm run test:next-nightly-integrity` — PASS; fixed Snapshot counts/hashes/orphans and VSPO Golden values unchanged
- `npm run test:bootstrap-error` — PASS
- `npm run test:cloud-restore-fail-closed` — PASS

## Safety and scope

- No Production DB or Production Supabase write.
- No Deploy or Push.
- No IndexedDB migration, schema change, Provider change, or closing-date batch rewrite.
- No Matching v2 implementation.
- Existing Product Identity v1 threshold and 5% ambiguity guard remain unchanged.
- Existing proxy `-2 days` behavior remains unchanged; business-rule review is separate.

