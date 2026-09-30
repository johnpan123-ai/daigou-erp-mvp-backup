# ERP schema reconciliation

This tool separates historical execution evidence from current schema-effect evidence. A migration is never reported as historically `APPLIED` unless an operational ledger explicitly proves that event. Catalog evidence is reported only as `SATISFIED`, `NEEDS_APPLY`, `PARTIAL`, `CONFLICT`, or `UNKNOWN`.

## Read-only capture

Run the SQL files in `sql/` in Supabase SQL Editor. They contain only catalog/data-integrity `SELECT` statements and do not expose business row values. Export the single JSON cell from the structural snapshot and the inventory-integrity result as JSON files.

Suggested order:

1. `live-schema-snapshot-readonly.sql` — complete structural catalog snapshot.
2. `026b-inventory-preconditions-readonly.sql` — exact PK/backfill safety counts.
3. `waca-restore-presence-readonly.sql` — quick WACA and Restore surface check.
4. `018b-import-batches-acl-matrix-readonly.sql` — exact/extra/missing ACL evidence for Data API and privileged roles.
5. `045b-waca-restore-compatibility-readonly.sql` — historical read-only evidence for the failed 045b attempt.
6. `045c-waca-restore-semantic-state-readonly.sql` — current behavior/catalog detector for pre-045, partial, compatible, canonical, or conflict states.
6. `ledger-history-readonly.sql` — only after the snapshot confirms the project-owned ledger exists.

Generate the candidate canonical target from the checked-in fresh-install chain in an isolated PostgreSQL 18 runtime:

```powershell
npm run schema:canonical-snapshot -- --output canonical-schema-v4.json
```

Pass the generated file directly as `--expected`. No production connection is used.

```powershell
node tools/schema-reconciliation/cli.mjs `
  --snapshot live-schema.json `
  --inventory-integrity inventory-integrity.json `
  --expected canonical-schema.json `
  --project-ref rhfdjsklfrgpoqsaqpkn `
  --source-head <40-character-sha> `
  --checkpoint <checkpoint-tag> `
  --baseline-id erp2-canonical-schema-v4 `
  --json live-delta.json
```

An incomplete snapshot fails closed. `PARTIAL`, `CONFLICT`, and `UNKNOWN` block Apply. A `NEEDS_APPLY` result is safe only when all declared structural and data preconditions pass.

The only exception is an explicit, checksum-bound compatibility closure in the
candidate registry. A covered `PARTIAL` or `CONFLICT` remains visible in the
evidence, but the original migration is omitted from the delta and only its
state-guarded repair may be planned. Uncovered or unknown states still block.

The project-owned ledger introduced by migration 047 is environment-local, non-portable operational metadata. It is deliberately excluded from the 24-resource business Backup/Restore contract. `BASELINE_ADOPTED` records a reconciled state and never fabricates historical migration execution; later real executions use `MIGRATION_APPLIED`.

In post-adoption mode, also export `ledger-history-readonly.sql` and add `--ledger-history <file> --mode POST_ADOPTION`. Supabase SQL Editor JSON exports may be either a single row/cell wrapper or the direct JSON value; the CLI accepts both.

## Post-migration Live reconciliation

When a fresh Live snapshot differs from the checked-in target, generate the
reviewable A/B/C/D/E classification before changing the canonical contract:

```powershell
node tools/schema-reconciliation/live-reconciliation-cli.mjs `
  --source canonical-schema.json `
  --live live-schema.json `
  --output live-schema-reconciliation.json
```

The ordered registry in `liveSchemaReconciliationRegistry.mjs` records the
caller/writer, migration origin, portability class, security impact and
resolution for each reviewed path. Unmatched differences are `UNKNOWN` and
block promotion. A difference classified as environment-local must also
disappear from the canonical projection; otherwise the report changes it to
`UNKNOWN` and fails closed. Migration 048 is the state-guarded portable
closure for the reviewed product-contract and security differences. It does
not apply environment-local or legacy Dashboard-image changes.
