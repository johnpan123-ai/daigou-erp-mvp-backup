# Sandbox Environment Architecture

Last updated: 2026-08-17 (Asia/Taipei)

## Scope

This document defines the two isolated local Sandbox environments created for
the next development cycle. They are local test environments only. They are
not Production deployments and must never be used as a source for a
Local-to-Cloud push.

## Environment matrix

| Environment | Branch | Port | Provider mode | IndexedDB | App storage namespace | Purpose |
| --- | --- | ---: | --- | --- | --- | --- |
| Production | `main` / `origin/main` | Cloud | `cloud` | `daigou-erp-db` | Production keys | Official operational data |
| Legacy Test | `codex/test-sandbox` | legacy local port | `test` | `daigou-erp-db-test-v1` | `__hippo_test_sandbox__::` | Existing Test Sandbox; preserved unchanged |
| Next Sandbox | `codex/next-sandbox` | 4192 | `next` | `daigou-erp-db-next-v1` | `__hippo_next_sandbox__::` | Daily validation of the next candidate |
| Experimental Sandbox | `codex/experimental-sandbox` | 4193 | `experimental` | `daigou-erp-db-experimental-v1` | `__hippo_experimental_sandbox__::` | Isolated high-risk experiments |

The Next and Experimental worktrees are independent. They do not share an
IndexedDB database, application localStorage, application sessionStorage, or
Snapshot import state.

## Runtime isolation

All three Sandbox modes use the local Test Owner path and the existing
`TestSandboxProvider` routing. The active Sandbox mode selects its fixed DB
name and storage namespace; it never dynamically falls back to Production or
another Sandbox DB.

The fail-closed network guard blocks requests to the configured Production
Supabase origin in Sandbox mode, including:

- `fetch`
- `XMLHttpRequest`
- `navigator.sendBeacon`
- WebSocket connections
- Supabase REST, RPC, Storage, and Functions paths

Sandbox Auth does not call Production Supabase Auth or read Production
profiles. Production Auth behavior remains on the existing Cloud path.

## Data direction

The only supported direction for a Sandbox data refresh is:

`Production JSON Snapshot file → one selected Sandbox IndexedDB`

The importer is Test-only, validates the complete file before opening its
transaction, clears only the selected Sandbox DB, writes all collections in a
single transaction, and records Snapshot metadata. It does not call the
Provider import API, Supabase, or any Production write path.

The same Production JSON Snapshot may be manually selected once in each
Sandbox. Selecting it in Next does not make it visible in Experimental, and
there is no Sandbox-to-Sandbox copy operation.

## Local commands

From the corresponding worktree:

```text
npm run dev:next
npm run dev:experimental
```

Builds are mode-specific:

```text
npm run build:next
npm run build:experimental
```

The dual isolation test and Snapshot parity test are:

```text
npm run test:dual-sandbox
npm run test:sandbox-snapshot-parity
```

## Manual Snapshot procedure

1. Open the selected Sandbox URL.
2. Open Settings.
3. Select `匯入正式版 JSON 快照`.
4. Choose the approved `workbench-backup-*.json` file.
5. Confirm the displayed filename and collection counts.
6. Confirm the warning that only the selected Sandbox DB will be replaced.
7. After import, verify the Snapshot metadata and counts.

Repeat the process independently in the other Sandbox if parity is required.
Do not use the Production UI to import a local Snapshot.

## Snapshot parity baseline

Snapshot: `workbench-backup-2026-08-15.json`

| Collection | Count |
| --- | ---: |
| inventory | 4096 |
| salesOrders | 0 |
| salesOrderItems | 0 |
| productGroups | 559 |
| productCategories | 305 |
| productVariants | 2438 |
| purchaseBatches | 467 |
| purchaseBatchItems | 1407 |
| privateOrders | 93 |
| privateOrderItems | 120 |
| bundleComponents | 284 |
| japanPackages | 36 |
| japanPackageItems | 225 |
| outboundShipments | 9 |
| outboundShipmentItems | 210 |

Next and Experimental imported the same Snapshot in isolated browser contexts;
all collection counts and collection hashes matched. The parity test also
confirmed that the Production IndexedDB and Production localStorage snapshots
were unchanged and that Supabase request count was zero.

## Performance baseline (measurement only)

The baseline script is `tests/sandbox-performance-baseline.mjs`. It does not
change application code or optimize any path. It imports the same Snapshot,
opens PurchaseRecords, reloads it, performs repeated search/sort actions, and
parses a 1300-row HTML/XLS-shaped inventory fixture in both environments.

| Measurement | Next | Experimental |
| --- | ---: | ---: |
| Snapshot import | 30,027 ms | 33,369 ms |
| PurchaseRecords first load | 2,210 ms | 3,317 ms |
| PurchaseRecords reload | 1,921 ms | 2,000 ms |
| 100 searches | 17,142 ms | 16,696 ms |
| 25 sorts | 2,966 ms | 3,313 ms |
| Category switch | 232 ms | 244 ms |
| 1300-row inventory parser | 32 ms | 30 ms |
| Production Supabase requests | 0 | 0 |

These figures are a starting baseline, not an approved performance fix. No
virtualization, search rewrite, `db.ts` rewrite, or data-model optimization is
included in this dual-Sandbox baseline.

## Checkpoint policy

Important checkpoints use Taiwan time (`Asia/Taipei`) and the format
`checkpoint-YYYYMMDD-HHMM-purpose`. Existing tags are retained and are not
renamed or deleted. Every future Sandbox checkpoint must be added to
`docs/restore-points.md` with its environment, commit, test state, Snapshot,
and whether it is recommended as a restore point.

