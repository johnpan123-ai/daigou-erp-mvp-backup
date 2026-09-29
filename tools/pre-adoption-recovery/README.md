# ERP 2.0 pre-adoption recovery bridge

This tool builds the temporary `PRE_ADOPTION_PARTIAL_STATE` recovery bundle v2 required while Live is committed through 018 + 044 + 018b, with 045/045b rolled back and the legacy 15-resource snapshot RPC still active. It is not the normal 24-resource Cloud backup and must not be exposed as a routine Restore option. Bundle v2 records schema fingerprint contract v2 explicitly so legacy hash evidence cannot be mistaken for the semantic fingerprint.

## Live capture (read-only)

### Luna execution package

A. Use the authenticated `hippo-erp` Wrangler profile to confirm the canonical account, Pages project, and domain, then generate the helper with `deadline-script`.

B. Open `https://hippo-erp-realtime-preview.pages.dev/settings` and wait until System Information shows the canonical Pages project, Supabase ref, and public fingerprint. Luna executes the generated helper inside that page context; the Supabase SQL Editor and another runtime origin are not valid substitutes.

C. The page downloads `erp2-deadline-durable-recovery.json`. The helper reads only the three durable stores in one IndexedDB `readonly` transaction and never logs row data.

D. Run `deadline-verify` locally. Keep the file outside Git; retain its checksum and store counts as recovery evidence.

For unattended operation, use a Chrome instance that was explicitly started with a loopback-only DevTools endpoint and already has the formal ERP2 Settings tab open. The exporter connects with Playwright `connectOverCDP`, rejects isolated evaluators and non-loopback endpoints, verifies the live page identity, reads only the three durable stores in a `readonly` transaction, and writes the JSON directly from the local process:

```powershell
$env:ERP2_CHROME_CDP_URL = 'http://127.0.0.1:9222'
npm run recovery:deadline-browser-export -- `
  --output C:\secure-recovery\erp2-deadline-durable-recovery.json
```

The active everyday Chrome profile is never copied or modified. If Chrome was not already launched with remote debugging, this command fails closed with `CDP_CONNECTION_UNAVAILABLE`; it does not inspect cookies, clone profile data, create a database, or fall back to an isolated browser context.

E. Run `assemble` with the existing streamed SQL export, live structural snapshot, and verified Deadline JSON. The command creates the Actual Recovery Bundle directly; Luna must not splice JSON manually.

F. Run `verify` on the assembled bundle, then preserve the bundle path, checksum, 26-resource count, and total row count for the Recovery Gate report.

1. Run `tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql` in the confirmed `rhfdjsklfrgpoqsaqpkn` SQL Editor and export the one JSON cell.
2. Run `tools/pre-adoption-recovery/sql/export-partial-state-readonly.sql` in the same confirmed project and export the one JSON cell.
3. Generate the read-only Deadline helper outside the repository while the authenticated `hippo-erp` Wrangler profile can read the canonical Cloudflare account and Pages project. Run the generated helper from the authenticated ERP 2.0 **Settings** page after its System Information fingerprint is visible. Generation embeds the read-only Wrangler account/project/domain proof; runtime execution cross-checks the exact Pages domain plus the displayed Cloudflare project, Supabase ref, and public fingerprint. If the deployed artifact already has `erp-build-identity.json`, its checksum and target identity are verified too. The historical `STAGING` / `PRODUCTION` runtime label is informational and is not used as an allow/deny signal. The helper then reads the Cloud Deadline IndexedDB with a `readonly` transaction and downloads the three durable arrays; it does not include analysis/cache stores:

```powershell
node tools/pre-adoption-recovery/cli.mjs deadline-script `
  --output C:\secure-recovery\deadline-sidecar-readonly.js
```

Do not paste the downloaded business data into chat or commit it to Git.

The helper refuses a wrong account, project, domain, Supabase ref, fingerprint, target role, tampered build manifest, missing System Information evidence, or missing IndexedDB catalog entry. A pre-build-identity runtime may omit the manifest only when the Wrangler proof, exact domain, and runtime System Information all match. It checks the catalog before `indexedDB.open`, so a missing Deadline database is never created by the export path.
4. Verify the downloaded Deadline file locally. Output contains only checksum and per-store counts, never row data:

```powershell
node tools/pre-adoption-recovery/cli.mjs deadline-verify `
  --deadline-sidecar C:\secure-recovery\deadline-durable.json
```

5. Build the bundle to an explicit path outside the Git worktree. `assemble` is the human-readable alias for the original `build` command:

```powershell
node tools/pre-adoption-recovery/cli.mjs assemble `
  --live-export C:\secure-recovery\partial-live-export.json `
  --schema-snapshot C:\secure-recovery\live-schema.json `
  --deadline-sidecar C:\secure-recovery\deadline-durable.json `
  --output C:\secure-recovery\erp2-pre-adoption-recovery.json `
  --project-ref rhfdjsklfrgpoqsaqpkn `
  --environment-role ERP_2_PRODUCTION `
  --expected-current-fingerprint e5c80e331720a2c02c301f43fe0ce536c6ee91a76c3b24851231d7f3131ef650 `
  --canonical-fingerprint fb920b22a907ce234af478ceff7fbbed98ec61d27813536c545590c1ac21cf77 `
  --checkpoint checkpoint-20260929-erp2-pre-adoption-recovery-bundle-v1
```

The output path is rejected if it is inside the repository. The CLI also rejects a dirty worktree or a checkpoint that does not peel to the current HEAD. It prints checksums and counts only, never business rows.

The assembler accepts exactly the streamed SQL export, the structural snapshot, and the verified Deadline JSON. It validates the 15 core resources, 8 supplement resources, and 3 Deadline durable stores before writing one Actual Recovery Bundle; no manual JSON splicing is required.

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

## Fingerprint reconciliation

Schema fingerprints have one implementation: `tools/schema-reconciliation/schemaContract.mjs`. Fingerprint contract v2 includes tables, columns, types, defaults, PK/FK, indexes, triggers, functions and definitions, RLS, policies, grants, and function ACL. It excludes owners, catalog OIDs, capture time, environment identity, migration-history observations, integrity results, and row counts. Catalog ordering and SQL formatting are normalized.

Calculate a fingerprint or compare two complete snapshots:

```powershell
node tools/schema-reconciliation/fingerprint-cli.mjs fingerprint `
  --snapshot C:\secure-recovery\live-schema.json

node tools/schema-reconciliation/fingerprint-cli.mjs diff `
  --old C:\secure-recovery\old-expected-schema.json `
  --current C:\secure-recovery\live-schema.json `
  --expected-old-fingerprint <old-semantic-fingerprint>
```

The diff reports true semantic changes separately from environment-local, evidence-only, ordering, and formatting differences. A historical fingerprint string without its exact snapshot fails closed with `OLD_SCHEMA_SNAPSHOT_REQUIRED`; a hash alone cannot reveal which structures differed.
