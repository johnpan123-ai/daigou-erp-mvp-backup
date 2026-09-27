# ERP Environment Identity Contract

Human roles and Cloudflare physical slugs are separate. A name containing `preview`
does not make a target safe for NEXT/Experimental. Keep physical slugs unchanged.

## Canonical map

| Role | Human name | Cloudflare account | Physical project / endpoint | Runtime | Supabase | Status |
| --- | --- | --- | --- | --- | --- | --- |
| ERP 1.0 | 小河馬訂購紀錄表 1.0 | `e0a58431cd5bcf0e01ec3438d531461a` | `daigou-erp-mvp-backup.pages.dev` | `PRODUCTION` (historical marker not independently proven) | `twzpqyesbtnfxdkorluf` | Locked; never deploy through this workflow |
| ERP 2.0 | 小河馬訂購紀錄表 2.0 | `e0a58431cd5bcf0e01ec3438d531461a` | `hippo-erp-realtime-preview.pages.dev` | `STAGING` / 測試雲端 | `rhfdjsklfrgpoqsaqpkn` | Accepted ERP2 runtime contract |
| NEXT | ERP NEXT | No proven Cloudflare target | `http://127.0.0.1:4192` | `NEXT` | `rhfdjsklfrgpoqsaqpkn` | Local only |
| Experimental | ERP Experimental / 高風險環境 | No proven Cloudflare target | `http://127.0.0.1:4193` | `EXPERIMENTAL` | `rhfdjsklfrgpoqsaqpkn` | Local only |
| Catalog | Catalog Worker | `f543371d2e71d3f9d81dc5863b1f16c9` | `xiaohebo-catalog-beta` Worker | `CATALOG` | Separate release process | Never an ERP target |

Machine-readable identities: [`config/erp-environment-identity.json`](../config/erp-environment-identity.json).
Profile `hippo-erp` must actually authenticate to the ERP account; `hippo-catalog` is separate.
The ERP2 fingerprint is `D9EA6B7BB6524517`. The Pages deployment branch is
`isolated-preview`; this is NOT the Git candidate branch.

## Accepted baseline is not the only deployable branch

Current accepted anchor (2026-09-27):

- Remote annotated tag: `accepted-20260927-erp2-deadline-v1-live`
- Peeled commit: `e565d067f49c95cf71dd6c95c5fab5b4749558f8`
- Accepted deployment: `2ea71f25-a0d0-4002-93ba-37fd408cba7b`
- Entry: `assets/index-VyvXxipw.js`; Provider: `assets/dataProvider-DmWx5fkp.js`
- Checkpoint: `checkpoint-20260927-erp2-deadline-v1-canonical-integration`

This accepted tag must not be moved to a candidate. Only after a separately authorized
deployment AND live acceptance may a NEW accepted tag and reviewed configuration update
advance the accepted anchor. An older task's complete branch name is not an environment identity.

The configuration's `currentDeployment` object retains the original environment-cleanup
capture (`43e4076c` / `3089fbce`, Atomic Restore acceptance). It is historical provenance,
not a current-active query or an authorization gate. Always read the actual active deployment
before release; stop if it differs from that release's approved live baseline.

## GitHub and environment hard gates

All conditions must pass together, before upload:

1. ERP2 role, human name, account ID, profile, project, runtime, Supabase, fingerprint match.
2. Candidate worktree is clean (tracked and untracked), checked-out branch and full HEAD match explicit inputs.
3. Remote URL is the approved GitHub repository, not an arbitrary local/fork remote.
4. Remote candidate branch exists and HEAD equals the actual candidate HEAD.
5. An EXPLICIT `--checkpoint-tag` exists remotely as an annotated tag and peels to candidate HEAD.
6. Remote accepted tag exists and peels to the configured accepted SHA (a local tag is not evidence).
7. `git --no-replace-objects merge-base --is-ancestor <remote-proven-accepted-SHA> <candidate-HEAD>` succeeds.
8. Candidate branch matches `codex/erp2-*` sanity format. This NEVER substitutes for SHA/checkpoint/ancestry.
9. Guard source itself is clean and backed by a remote branch/checkpoint, with accepted ancestry.
10. Actual Wrangler `whoami` contains the exact ERP account ID; Pages project is visible under
    the named profile and explicitly pinned `CLOUDFLARE_ACCOUNT_ID`.

No latest-tag guessing, no arbitrary checkpoint search, no local-only accepted tag, no unpushed candidate.
Git/network/authentication failures fail closed. A PASS is a read-only identity check, not an upload,
not artifact verification, and not permission to skip release-specific gates. Re-run immediately
before upload; do not reuse a stale PASS after branch, tag, source, session or artifact changes.

## Guard source versus runtime source

The guard may be newer than the runtime artifact. Keep the original candidate worktree checked
out at its fixed HEAD. Run the new guard from its own backed-up worktree and pass
`--candidate-worktree` explicitly. Git and Wrangler candidate checks run in that worktree;
the guard configuration is loaded from the guard's own source, not the candidate's old config.

For Quick Wins, from the guard-fix worktree (replace only the absolute candidate path):

```text
npm run verify:erp-deployment-identity -- --candidate-worktree "C:/path/to/erp2-workflow-ux-quick-wins-v1" --role erp2 --profile hippo-erp --project hippo-erp-realtime-preview --supabase-project rhfdjsklfrgpoqsaqpkn --runtime-marker STAGING --fingerprint D9EA6B7BB6524517 --source-head 68269ad9e80762c07d64fde38194a56e3db69e1f --remote-branch codex/erp2-workflow-ux-quick-wins-v1 --checkpoint-tag checkpoint-20260927-erp2-workflow-ux-quick-wins-v1 --guard-checkpoint-tag checkpoint-20260927-erp2-deployment-guard-lineage-fix-v1
```

`--guard-checkpoint-tag` is required when the guard source HEAD/branch differs from the runtime
candidate. When both are the same, the explicitly supplied candidate checkpoint also proves
the guard. Output separates `guardSourceHead` / `guardSource` from `sourceHead` / candidate proof.
Never put the guard-fix SHA into Cloudflare runtime source metadata for an artifact built at `68269ad9`.

Quick Wins artifact remains fixed at `68269ad9`:

- Entry: `assets/index-CmjToX2m.js`
- Provider: `assets/dataProvider-ngRYOiPH.js`
- Workbench: `assets/ClosingDateResolutionWorkbench-CJfC7MsL.js`
- Manifest: `FABCD9B5C3F3D75D62F70AF5494AA6B6087DE5922EDBC40CF8E00BEE0595DD41`

This guard-only fix does not rebuild or retarget that artifact. Artifact byte verification,
Functions provenance, current-live baseline checks and final authorized deployment are separate gates.

Wrangler 4.141.0 is pinned for the read-only calls (no product dependency upgrade). Its local
`whoami --help` has no `--profile`, while `pages project list --help` supports it. The candidate
worktree's active session must therefore already be correct. No login/logout or credential reads
are performed by the guard; command failure output is suppressed to avoid leaking credentials.
See [Cloudflare general commands](https://developers.cloudflare.com/workers/wrangler/commands/general/).

## Permanent recovery and delivery workflow

Accepted Live Baseline → task Recovery Tag → push Recovery Tag → verify remote peeled SHA
→ isolated Feature Branch → implementation → tests → build (only when needed) → commit(s)
→ explicit Checkpoint → push branch AND Checkpoint → remote SHA verification
→ Deployment Guard → authorized Deploy → Live Acceptance → NEW Accepted Tag.

For this task, recovery tag `backup-20260927-before-erp2-deployment-guard-lineage-fix-v1`
points to the preserved Quick Wins candidate `68269ad9`. The fix branch is
`codex/erp2-deployment-guard-lineage-fix-v1`, with checkpoint
`checkpoint-20260927-erp2-deployment-guard-lineage-fix-v1`.

Use `[CF-Pages-Skip]` at the beginning of delivery commit subjects to prevent Git backup
pushes from triggering Git-connected Pages builds. This never authorizes a CLI deployment.

## Physical naming decision

`KEEP PHYSICAL SLUG / FIX CANONICAL LABELS` remains in force. The original cleanup did not
prove an in-place rename preserving domains/history/bindings/rollback. Do not rename or create
projects to work around identity checks. Historical recovery tag
`backup-20260926-erp2-live-restore-accepted-before-cloudflare-rename` preserves `3089fbce`;
it is not the current accepted-lineage anchor.
