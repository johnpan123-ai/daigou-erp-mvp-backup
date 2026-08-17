# Dual Sandbox Unattended Validation — 2026-08-17

Timezone: Asia/Taipei (UTC+8)

This log records automated validation performed while the operator is away.
It does not replace manual acceptance. A stage is never marked `Accepted`
unless the operator has completed the requested manual SOP.

## Stage status vocabulary

- `Implementation Passed / Awaiting Manual Acceptance`: automated checks passed;
  browser actions have not been accepted by the operator.
- `Field Testing`: automated checks passed and the feature is ready for the
  operator to exercise locally.
- `Accepted`: reserved for explicit operator confirmation after manual SOP.

## Stage 0 — starting baseline

Recorded: 2026-08-17 11:03:48 Asia/Taipei.

| Environment | Commit / branch | DB | Port | Snapshot state | Git |
| --- | --- | --- | ---: | --- | --- |
| Production | `c3756cd55e90658546a1936c6549411c540351f3` / `origin/main` | Production DB | Cloud | Not read or changed in this stage | Clean |
| Next | `0e331685c73d5d8b03a9561ecbc44b192d0d7dd4` / `codex/next-sandbox` | `daigou-erp-db-next-v1` | 4192 | Empty before manual Snapshot import; Settings UI showed 0 rows | Clean |
| Experimental | `93d6c54bef8f288f0500083ee40974910e2b3024` / `codex/experimental-sandbox` | `daigou-erp-db-experimental-v1` | 4193 | Empty before manual Snapshot import; Settings UI showed 0 rows | Clean |

The approved Snapshot reference for the Sandbox test is
`workbench-backup-2026-08-15.json`. Its previously verified collection counts
are recorded in `docs/sandbox-environments.md`; those counts are not claimed
to be a live Production read at this Stage 0 timestamp.

Production data was not written, synchronized, restored, migrated, or cleared.

Checkpoint:

`checkpoint-20260817-1103-stage-00-before-unattended-validation`

## Stage 1 — Snapshot parity

Automated parity was previously executed independently in both Sandbox modes;
the same Snapshot produced identical counts and collection hashes. Persistent
browser tabs remain empty until the operator manually selects the file in each
Sandbox Settings page. This is intentional: the Snapshot contains real ERP
data and is not uploaded automatically by this unattended run.

Status: `Implementation Passed / Awaiting Manual Acceptance`.

## Stage 2 — isolation

The automated isolation test passed for independent DB names, storage
namespaces, cross-visibility, fail-closed Supabase requests, and zero observed
Production requests. The lifecycle test also passed: both Sandboxes imported
the same Snapshot, persisted mode-only rows across reload, cleared independently,
and re-imported independently without changing the other Sandbox. Physical
Production IndexedDB remained unchanged and both request logs stayed empty.

Manual clear/reload/re-import SOP remains pending.

Status: `Implementation Passed / Awaiting Manual Acceptance`.

Automated command: `npm run test:dual-sandbox-lifecycle` (Next and Experimental).

Checkpoint tags:

- `checkpoint-20260817-1112-stage-02-dual-sandbox-lifecycle`
  (`344801a` on Next)
- `checkpoint-20260817-1115-experimental-stage-02-dual-sandbox-lifecycle`
  (`d647278` on Experimental)

## Stage 3 — selected feature regression

The selected, already completed features were exercised through their
targeted Sandbox tests: second-level official link, independent Recent
Purchases page, purchase-operation safety UI, daily ledger copy, freight
allocation behavior, and the Local Mode guest entry. The tests passed without
Production requests or writes. No unrelated feature was added in this stage.

Status: `Implementation Passed / Awaiting Manual Acceptance`.

## Stage 4 — PurchaseRecords and save-race regression

Core regression and the existing PurchaseRecords proxy-agent regression
passed. The full production-like outbound receiving race suite also passed;
it is recorded separately in Stage 7. No new PurchaseRecords formula or
provider logic was changed during this audit.

Status: `Implementation Passed / Awaiting Manual Acceptance`.

## Stage 5 — purchasing workspace and ledger regression

Purchase Management action-level checks passed: the purchase-batch action is
primary, secondary actions remain separated, modal labels are distinct, the
legacy product-level copy control stays hidden, and batch-history copy remains
available. Recent Purchases daily ledger copy and original batch preservation
also passed. No purchase data was written by these checks.

Status: `Implementation Passed / Awaiting Manual Acceptance`.

## Stage 6 — Japan Package and bundle display regression

The existing bundle display behavior and source associations were reviewed
against the Feature Registry. No new bundle/package data was written. A fresh
dedicated browser test for every Japan Package visual variant was not added in
this audit, so this stage remains field-testing only.

Status: `Field Testing`.

## Stage 7 — Outbound regression

Outbound export checks passed, including relation-based purchase JPY cost
output, blank unresolved/null/zero costs, and unchanged checked state. The
serial receiving-save regression passed for rapid 10-item toggles, immediate
F5/navigation, same-SKU source items, toggle-back, and visible save failure.
The underlying item IDs and checked/checked_at model were not changed.

Status: `Implementation Passed / Awaiting Manual Acceptance`.

## Stage 8 — P0-A, P0-B and P0-F regression

The maintained Snapshot Import suite passed atomic validation, rollback,
readback and isolation. Cloud restore fail-closed and bootstrap-error-boundary
tests passed. The legacy `tests/atomic-import-data.mjs` entry still fails at
its baseline assertion because it assumes legacy `test` mode on port 4193,
which is intentionally owned by Experimental mode; this is recorded as a
test-harness compatibility issue, not a product-data failure.

P0-A/B/F remain `Implementation Passed / Awaiting Manual Acceptance` unless
the operator has completed the manual SOP. P0-C/D/E remain Design Gate.

## Stage 9 — P0-C/D/E design gate

No front-end compensation or partial-write workaround was attempted.

- P0-C purchase batch header/items still needs an approved atomic boundary.
- P0-D Inventory import and PurchaseRecords synchronization still consists of
  separate writes.
- P0-E outbound header/item deletion still consists of separate writes.

Status: `Design Gate`; no code change.

## Stage 10 — Experimental baseline

The fixed Snapshot benchmark completed in both environments with Production
Supabase request count zero. The benchmark is a measurement checkpoint only;
it does not claim an optimization.

## Stage 11 — PurchaseRecords performance analysis

PurchaseRecords search, sort, category switching, first load and reload were
measured on the fixed Snapshot. Next and Experimental showed large runtime
variance despite identical source, so there is no stable Before/After gain to
ship. Existing deferred search, memoized indexes/maps and derived lists were
left unchanged. No virtualization or table rewrite was attempted.

Status: `Analysis Only`; no code change.

## Stage 12 — Product/Variant import performance analysis

The XLS parser measured approximately 38 ms for the fixed 1,300-row fixture.
Snapshot import time was dominated by validation, stable serialization/hash,
the atomic IndexedDB transaction, and complete readback verification. Atomic
and checksum gates were not weakened, and no import code was changed.

Status: `Analysis Only`; no code change.

## Stage 13 — stability audit v3

The full report is in `docs/system-stability-audit-v3.md`. It records P1
empty-vs-error fallback risks, the PurchaseRecords fresh-load rejection risk,
IndexedDB fallback behavior, low-risk timer observations, date consistency
limits, import/backup findings, performance measurements, and Sandbox
isolation. No finding was silently fixed in this stage.

Status: `Implementation Passed / Awaiting Manual Acceptance` for automated
coverage; analysis findings remain unimplemented.

## Stage 14 — Feature Registry audit

The Feature Registry was reviewed for the selected features and existing
Production-readiness markers. No feature was promoted to `Accepted`, no
Production-ready tag was created, and no Test-only infrastructure was marked
Production-ready. The Registry and Restore Point Index will be updated with
the audit commit and stage checkpoints only after the report is committed.

Overall unattended status: `Field Testing`.

The persistent Next (4192) and Experimental (4193) browsers are left running
for manual verification. No Snapshot is auto-imported into either persistent
browser because it contains real ERP data.
