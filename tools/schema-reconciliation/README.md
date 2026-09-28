# ERP schema reconciliation

This tool separates historical execution evidence from current schema-effect evidence. A migration is never reported as historically `APPLIED` unless an operational ledger explicitly proves that event. Catalog evidence is reported only as `SATISFIED`, `NEEDS_APPLY`, `PARTIAL`, `CONFLICT`, or `UNKNOWN`.

## Read-only capture

Run the SQL files in `sql/` in Supabase SQL Editor. They contain only catalog/data-integrity `SELECT` statements and do not expose business row values. Export the single JSON cell from the structural snapshot and the inventory-integrity result as JSON files.

Suggested order:

1. `live-schema-snapshot-readonly.sql` — complete structural catalog snapshot.
2. `026b-inventory-preconditions-readonly.sql` — exact PK/backfill safety counts.
3. `waca-restore-presence-readonly.sql` — quick WACA and Restore surface check.
4. `ledger-history-readonly.sql` — only after the snapshot confirms the project-owned ledger exists.

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

The project-owned ledger introduced by migration 047 is environment-local, non-portable operational metadata. It is deliberately excluded from the 24-resource business Backup/Restore contract. `BASELINE_ADOPTED` records a reconciled state and never fabricates historical migration execution; later real executions use `MIGRATION_APPLIED`.

In post-adoption mode, also export `ledger-history-readonly.sql` and add `--ledger-history <file> --mode POST_ADOPTION`. Supabase SQL Editor JSON exports may be either a single row/cell wrapper or the direct JSON value; the CLI accepts both.
