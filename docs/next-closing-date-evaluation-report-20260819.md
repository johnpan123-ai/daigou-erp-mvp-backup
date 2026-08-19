# Next Closing Date Matching Evaluation Report

## Status

**Evaluation Harness Implemented / Matching v2 Not Started**

This report is for the Next Sandbox only. It does not promote the feature to Production Ready.

## Harness architecture

The evaluation is split into two explicit stages:

1. **Capture:** `capture:closing-date-fixtures` performs read-only `GET` requests to the configured Catalog gateway and stores only the ERP title, attempted queries, response status, and the necessary candidate identity/supplier/deadline fields in `tests/fixtures/closing-date/dataset.json`. It never reads ERP IndexedDB and never calls a Provider.
2. **Offline replay:** `test:closing-date-evaluation` loads the saved candidates into the existing Product Identity / Supplier Selection functions. It does not call Catalog, Supabase, IndexedDB, or any Provider. The test fails if an `/api/` or Supabase request is observed.

Existing fixtures are reused by default. `--refresh` is required to recapture a query, and `--write` is required before the capture utility may update the test fixture file.

## Evaluation result — expanded dataset

The fixture now contains **44 real proxy Product Groups** selected from the
fixed `workbench-backup-2026-08-15.json` snapshot. Each expanded case keeps its
source `productGroup` ID and was captured through the read-only Next Catalog
gateway. The original six regression assertions and two known retrieval
failures remain unchanged; the 36 new cases are deliberately marked
`OBSERVE`, not as approved business truth.

| Result bucket | Count | Meaning |
| --- | ---: | --- |
| Existing Golden PASS | 6 | Existing matching/type/supplier assertions still pass |
| Existing KNOWN FAILURE | 2 | Yumemirize retrieval gaps intentionally preserved |
| Expanded observed MATCH | 8 | Current algorithm found a candidate; not yet manually accepted |
| Expanded observed AMBIGUOUS | 0 | No expanded case reached the ambiguity result in this replay |
| Expanded observed NOT_FOUND | 28 | No safe automatic candidate; requires cluster analysis or future design |
| REGRESSION | 0 | No existing Golden assertion regressed |

**Total: 44 / 6 Golden PASS / 2 KNOWN FAILURE / 8 observed MATCH / 28 observed NOT_FOUND / 0 REGRESSION.**

The 36 expanded cases were not converted into unconditional PASS assertions:
the replay can prove deterministic behavior and zero-write matching decisions,
but correctness of a newly selected real product still needs manual field
confirmation against the source listing.

## Dataset coverage

| Segment | Cases included | Notes |
| --- | ---: | --- |
| GSC / Nendoroid | 8 including the existing 峰月律 Golden | Model numbers, Chinese/Japanese/English names, versions, and ERP prefixes |
| GSC / figma | 5 including the existing 路西法 Golden | English/Japanese titles and model-number case |
| GSC / POP UP PARADE | 4 including the existing 橘雪莉 L Size Golden | L Size metadata and same-line candidates |
| Scale Figure / other manufacturers | 5 | 1/6, 1/7, 1/8, PVC, and version text |
| SEGA / prize lines | 3 including two Yumemirize known failures | Yumemirize and Relax time coverage |
| FuRyu / prize lines | 6 | Hikkake, MOCHIPICO, and prize titles; same-character cross-line samples |
| GSC / Chocopuni | 3 | Plush/product-line retrieval coverage |
| Bandai / prize and model lines | 6 | SMP, Robot Spirits, SHF, and mixed-language titles |
| Other lines | 4 | Phat!, PLAMATEA, Luminous Box, and related scale/model cases |

## Failure clusters

The expanded replay produced these observed clusters. Counts below are
exploratory outcomes, not a claim that every NOT_FOUND is a confirmed source
absence.

| Cluster | Observed cases | MATCH | NOT_FOUND | Main signal |
| --- | ---: | ---: | ---: | --- |
| GSC / Nendoroid | 7 | 2 | 5 | Identity/series and retrieval coverage vary by title form |
| GSC / figma | 4 | 4 | 0 | Current type + final identity token is effective for these samples |
| GSC / POP UP PARADE | 3 | 1 | 2 | Retrieval gaps for some characters despite type/size-aware queries |
| Scale Figure | 4 | 1 | 3 | Product-line/manufacturer coverage and identity token extraction are weak |
| Prize / FuRyu / Bandai / Chocopuni / other lines | 18 | 0 | 18 | Most lines are not modeled by the current v1 product-type vocabulary and/or return no candidate |

Across the 36 exploratory cases, **17 had at least one non-empty Catalog
response and 19 had no candidate returned by any attempted query**. Of the 17
with candidates, 8 selected a candidate and 9 remained fail-closed. This
separates Retrieval coverage from Matching/Reranking coverage without changing
either threshold or ambiguity policy.

## Root-cause pattern for the next design

The dominant signal is **Product Line / Catalog Retrieval coverage**, not a
single global threshold problem:

- 19 cases failed before candidate scoring because all captured queries returned
  an empty list.
- The current v1 vocabulary models only `FIGMA`, `NENDOROID`,
  `NENDOROID_DOLL`, `POP_UP_PARADE`, and `SCALE_FIGURE`; SEGA prize lines,
  Chocopuni, Hikkake, MOCHIPICO, SMP, Robot Spirits, and SHF are not first-class
  product types in the current normalizer.
- Some responses contain similarly named cross-line products (for example a
  1/7 listing returned for an Hikkake query). Fail-closed NOT_FOUND is safer
  than lowering the threshold or accepting a line conflict.
- No expanded case produced AMBIGUOUS in this offline replay, so this dataset
  does not justify changing the existing 5% ambiguity guard.

The next work item is therefore a **Matching v2 design** covering retrieval
queries, Product Line metadata, manufacturer/line constraints, and manual
ground truth. It is not implemented by this dataset expansion.

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
