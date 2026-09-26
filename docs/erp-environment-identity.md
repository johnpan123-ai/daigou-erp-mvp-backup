# ERP Environment Identity Contract

This repository uses human-readable environment roles separately from Cloudflare's physical project slugs. The physical slugs are intentionally locked until Cloudflare documents a rename operation that preserves the `pages.dev` hostname, deployment history, aliases, bindings, functions, custom domains, and rollback behavior.

## Canonical map

| Role | Human name | Account | Physical project / endpoint | Domain | Runtime marker | Supabase | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ERP 1.0 | 小河馬訂購紀錄表 1.0 | `e0a58431cd5bcf0e01ec3438d531461a` | `daigou-erp-mvp-backup` | `https://daigou-erp-mvp-backup.pages.dev/` | `PRODUCTION` (bundle marker not independently proven in this pass) | `twzpqyesbtnfxdkorluf` | Locked; no deployment in this workflow |
| ERP 2.0 | 小河馬訂購紀錄表 2.0 | `e0a58431cd5bcf0e01ec3438d531461a` | `hippo-erp-realtime-preview` | `https://hippo-erp-realtime-preview.pages.dev/` | `STAGING` / 測試雲端 | `rhfdjsklfrgpoqsaqpkn` | Accepted live baseline |
| NEXT | ERP NEXT | not a Cloudflare target | local `http://127.0.0.1:4192` | local only | `NEXT` | `rhfdjsklfrgpoqsaqpkn` | Local sandbox |
| Experimental | ERP Experimental / 高風險環境 | not a Cloudflare target | local `http://127.0.0.1:4193` | local only | `EXPERIMENTAL` | `rhfdjsklfrgpoqsaqpkn` | Local sandbox |
| Catalog | Catalog Worker | `f543371d2e71d3f9d81dc5863b1f16c9` | `xiaohebo-catalog-beta` | `https://xiaohebo-catalog-beta.comiindex-hippo.workers.dev` | `CATALOG` | separate release process | Separate account and release process |

The machine-readable source is [`config/erp-environment-identity.json`](../config/erp-environment-identity.json).

## Accepted baselines

ERP 2.0 is locked to the accepted live-acceptance baseline:

- Deployment: `43e4076c-e347-4fff-b4f1-8b472ed174bd`
- Source: `3089fbcec9e44323522c758059689bb7641d20eb`
- Entry: `assets/index-Bo2YCBoE.js`
- Provider: `assets/dataProvider-DnirxCMa.js`
- Supabase: `rhfdjsklfrgpoqsaqpkn`
- Fingerprint: `D9EA6B7BB6524517`
- Atomic Restore: live acceptance passed; epoch 8

Cloudflare's read-only Pages inventory showed the ERP 2.0 project on branch `isolated-preview` and the ERP 1.0 project on branch `main`. The ERP 2.0 deployment remained unchanged during this cleanup.

## Deployment guard

Before any ERP upload, run the guard with the exact candidate identity and the GitHub gate values:

```text
npm run verify:erp-deployment-identity -- --role erp2 --profile hippo-erp --project hippo-erp-realtime-preview --supabase-project rhfdjsklfrgpoqsaqpkn --runtime-marker STAGING --fingerprint D9EA6B7BB6524517 --source-head 3089fbcec9e44323522c758059689bb7641d20eb --remote-branch codex/atomic-restore-durable-failure-recovery-v1 --checkpoint-tag checkpoint-20260926-atomic-restore-execute-dispatch-boundary-v3
```

The guard fails closed unless all of these match:

- active Wrangler `whoami` account ID
- named profile expected for the role
- visible Pages project
- physical project slug
- runtime marker
- Supabase project
- public fingerprint
- clean worktree
- local HEAD
- remote branch HEAD
- remote checkpoint peeled HEAD

Wrangler 4.141.0 does not accept `--profile` for `whoami`; the guard therefore validates the active `whoami` account ID and separately uses the named profile for the read-only Pages visibility check. Credentials, tokens, cookies, and secrets are never printed.

## Rename decision

`SAFE IN-PLACE RENAME` was not proven. Wrangler's Pages CLI exposes project list/create/delete/deploy commands but no rename command. Cloudflare's Pages API exposes a project `PATCH` with a `name` field, while the official documentation states that the project name is used for the `pages.dev` hostname. It does not guarantee preservation of the old hostname, deployment aliases, history, bindings, or rollback semantics. The safe decision is therefore:

`KEEP PHYSICAL SLUG / FIX CANONICAL LABELS`

Do not create `hippo-erp-v1` or `hippo-erp-v2`, and do not PATCH a live project name as part of this cleanup.

## GitHub pre-deploy gate

The accepted baseline is backed up by:

- Branch: `codex/atomic-restore-durable-failure-recovery-v1`
- Checkpoint: `checkpoint-20260926-atomic-restore-execute-dispatch-boundary-v3`
- Recovery tag: `backup-20260926-erp2-live-restore-accepted-before-cloudflare-rename`
- All three point to `3089fbcec9e44323522c758059689bb7641d20eb` after peeling annotated tags.

The permanent order is:

`Tests → Build (when needed) → Commit → Checkpoint → Push branch → Push checkpoint/recovery tag → Verify remote HEAD → Deploy`

No deploy is valid when the local branch, remote branch, and remote checkpoint do not resolve to the same candidate commit.
