# ERP 2.0 pre-adoption recovery bridge

This tool builds the temporary `PRE_ADOPTION_PARTIAL_STATE` recovery bundle required while Live is committed through 018 + 044 but still uses the legacy 15-resource snapshot RPC. It is not the normal 24-resource Cloud backup and must not be exposed as a routine Restore option.

## Live capture (read-only)

1. Run `tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql` in the confirmed `rhfdjsklfrgpoqsaqpkn` SQL Editor and export the one JSON cell.
2. Run `tools/pre-adoption-recovery/sql/export-partial-state-readonly.sql` in the same confirmed project and export the one JSON cell.
3. Generate the read-only Deadline helper outside the repository while the authenticated `hippo-erp` Wrangler profile can read the canonical Cloudflare account and Pages project. Run the generated helper from the authenticated ERP 2.0 **Settings** page after its System Information fingerprint is visible. Generation embeds the read-only Wrangler account/project/domain proof; runtime execution cross-checks the exact Pages domain plus the displayed Cloudflare project, Supabase ref, and public fingerprint. If the deployed artifact already has `erp-build-identity.json`, its checksum and target identity are verified too. The historical `STAGING` / `PRODUCTION` runtime label is informational and is not used as an allow/deny signal. The helper then reads the Cloud Deadline IndexedDB with a `readonly` transaction and downloads the three durable arrays; it does not include analysis/cache stores:

```powershell
node tools/pre-adoption-recovery/cli.mjs deadline-script `
  --output C:\secure-recovery\deadline-sidecar-readonly.js
```

Do not paste the downloaded business data into chat or commit it to Git.

The helper refuses a wrong account, project, domain, Supabase ref, fingerprint, target role, tampered build manifest, missing System Information evidence, or missing IndexedDB catalog entry. A pre-build-identity runtime may omit the manifest only when the Wrangler proof, exact domain, and runtime System Information all match. It checks the catalog before `indexedDB.open`, so a missing Deadline database is never created by the export path.
4. Build the bundle to an explicit path outside the Git worktree:

```powershell
node tools/pre-adoption-recovery/cli.mjs build `
  --live-export C:\secure-recovery\partial-live-export.json `
  --schema-snapshot C:\secure-recovery\live-schema.json `
  --deadline-sidecar C:\secure-recovery\deadline-durable.json `
  --output C:\secure-recovery\erp2-pre-adoption-recovery.json `
  --project-ref rhfdjsklfrgpoqsaqpkn `
  --environment-role ERP_2_PRODUCTION `
  --expected-current-fingerprint 84ed86f61075e3f5d8958444f249cf0308ff90a1f9673c944aaafae4c606194d `
  --canonical-fingerprint 6775a09526b7c55b8dd96d0d1d83dba12954f5d1c8d6dde8503d647f133a963b `
  --checkpoint checkpoint-20260929-erp2-pre-adoption-recovery-bundle-v1
```

The output path is rejected if it is inside the repository. The CLI also rejects a dirty worktree or a checkpoint that does not peel to the current HEAD. It prints checksums and counts only, never business rows.

`import_batches` is classified as `MUST RESTORE` by the product durable-resource registry because it carries import/idempotency history. It is therefore part of the partial supplement, not operational metadata. The 047 migration ledger remains environment-local operational metadata and is never restored as business data.

Verify independently:

```powershell
node tools/pre-adoption-recovery/cli.mjs verify `
  --bundle C:\secure-recovery\erp2-pre-adoption-recovery.json `
  --expected-project-ref rhfdjsklfrgpoqsaqpkn
```

The bundle fails closed on unknown/missing resources, a missing WACA singleton, missing Deadline durable sections, checksum changes, broken relationships, a wrong structural fingerprint, or schema effects outside the exact partial state.

## Retirement

The bridge becomes `NOT REQUIRED FOR NORMAL OPERATIONS` only after the canonical fingerprint is reached, the 24-resource Cloud backup passes, the 24-resource restore validation passes, and the baseline is adopted. The bridge never replaces Cloud Backup → NEXT Restore or the normal 24-resource Cloud contract.
