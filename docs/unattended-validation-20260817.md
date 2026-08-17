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
