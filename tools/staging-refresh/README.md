# Production → Staging Full Snapshot Refresh

This operator-only tooling is separate from the browser ERP restore. It never
uses IndexedDB as a Production source and never accepts Production as a target.

## Hard boundaries

- Production source: `twzpqyesbtnfxdkorluf`
- Staging target: `rhfdjsklfrgpoqsaqpkn`
- Source and target must differ.
- There is no `force` option.
- Database credentials are supplied only through process environment variables
  and are never written to a snapshot or manifest.
- PostgreSQL credentials are read only from the operator process environment.
  They are not command-line arguments and never enter snapshot manifests.
- Production snapshots use only `STAGING_REFRESH_SOURCE_DATABASE_URL`.
- Staging rollback snapshots and `dry-run` use only `STAGING_REFRESH_TARGET_DATABASE_URL`.
- `restore --execute` uses only `STAGING_REFRESH_RESTORE_DATABASE_URL`; the
  Staging reader is never used as a fallback.
- The restore URL must identify the dedicated `staging_refresh_restore_writer`
  role on `rhfdjsklfrgpoqsaqpkn`. Production refs, other project refs,
  `postgres`, `service_role`, IP-address hosts and unrecognized hosts are
  rejected before a database session is opened.
- Browser Cloud Restore remains disabled.

## Before the first dry run

1. Verify the live Cloudflare Production and Staging project settings.
2. Provision separate read-only Production and Staging DB credentials. Never
   use a browser anon key or service-role key in the app.
3. Pause Staging users, importer jobs and Realtime writers.
4. Classify every table listed as `SCHEMA_REVIEW_REQUIRED`. Migrations 018/019
   are not assumed to exist and are not applied automatically.
5. Choose `internal-preserve` only when Staging is restricted to the same
   authorized internal operators. `masked` intentionally remains blocked until
   its field-by-field policy is implemented and accepted.

## Staging-only schema parity (2026-09-05 live audit)

The targeted SQL artifact is:

```text
tools/staging-refresh/sql/staging_schema_parity_20260905.sql
```

It is deliberately outside `supabase/sql`, so it cannot be swept into a normal
Production migration or deploy. It is a one-time, fail-closed migration for the
audited legacy schema on `rhfdjsklfrgpoqsaqpkn`; it is not a general migration
and is not idempotent. The preflight requires the exact legacy Staging columns,
constraints and standalone indexes. The current Production schema already has
the target columns and therefore refuses the preflight before any `ALTER`.

The SQL performs all changes and postflight row-projection checks in one
transaction. Invalid non-empty date text, nullable `sales_orders.buyer_name`,
unexpected/partial schema state, data drift or a postflight mismatch aborts the
transaction. Empty legacy date strings are explicitly mapped to SQL `NULL`.

The SQL does not rebuild business tables merely to copy Production's physical
column order. Rebuilding would replace table identity and risk grants, RLS,
triggers and dependencies. Refresh schema compatibility already compares every
named column's type/null/default/generated/identity contract. The manifest now
sorts catalog arrays before hashing so the post-restore fingerprint follows the
same strict semantic contract: array order alone is ignored, while any column,
FK or constraint definition change still fails. The FK contract includes the
constraint name, child/parent schemas and columns, composite-column ordinal,
normalized `ON DELETE` / `ON UPDATE` actions, and validation state.
Snapshots created before this FK contract was added do not contain enough
evidence and must be recaptured; the tooling fails closed instead of inferring
missing actions or rewriting an existing snapshot JSON.

New snapshots carry `schemaContractVersion: 2`. Their catalog evidence also
records that FK and PK/UNIQUE inspection completed plus each contract's
constraint and column counts. PK/UNIQUE metadata comes from deterministic
`pg_catalog` rows rather than the role-filtered `information_schema` constraint
views. Envelope validation rejects a missing/older contract, missing FK fields,
malformed actions, inconsistent composite ordinals or mismatched counts with
`SNAPSHOT_SCHEMA_CONTRACT_UNSUPPORTED`. An empty FK or PK/UNIQUE array is
accepted only when the versioned catalog evidence explicitly records complete
inspection with zero constraints and zero columns. Existing Production and
Staging rollback snapshots, including earlier v2 files without PK/UNIQUE
completeness evidence, are never upgraded in place; both must be recaptured
before the next dry run.

The migration:

- makes `inventory_items.id` the UUID primary key while retaining a UNIQUE
  `inventory_key` for existing importer upserts; snapshot ID-set hashing now
  follows the canonical UUID primary key;
- adds the two catalog metadata columns and the Production index;
- converts `product_groups.purchase_date` and `purchase_batches.date` to
  PostgreSQL `date` after exact `YYYY-MM-DD` validation;
- makes the two optional Product Variant adjustment columns nullable with no
  default, without changing existing values;
- adds Sales row `version`, enforces non-null buyer names, and permits nullable
  item `price` / `amount` while keeping their default of 0;
- changes the two audited Product Group header FKs from RESTRICT to CASCADE;
- changes only the standalone sales order-number index to non-unique, preserves
  the constraint-backed UNIQUE index, and removes the two audited Staging-only
  `deleted_at` indexes.

This artifact has no automatic Cloud execution path. Applying it requires a
separately authorized operator step that proves the target project ref is the
isolated Staging project. Do not run it with a Production URL, `service_role`,
the read-only snapshot credentials or the restore writer. Migrations 018/019
are unrelated and are not included.

Offline verification:

```text
npm run test:staging-schema-parity
```

## Read-only snapshot commands

Set `STAGING_REFRESH_SOURCE_DATABASE_URL` to a Production read-only PostgreSQL
connection whose host or user identity contains the Production project ref.

```text
node tools/staging-refresh/cli.mjs snapshot --role=production --pii-mode=internal-preserve --output=production-snapshot.json
```

Set `STAGING_REFRESH_TARGET_DATABASE_URL` to the isolated Staging PostgreSQL
connection, then create the rollback backup immediately before a dry run or
restore:

```text
node tools/staging-refresh/cli.mjs snapshot --role=staging-rollback --pii-mode=internal-preserve --output=staging-rollback.json
```

Both commands use one repeatable-read, read-only database transaction. They
write only local snapshot and manifest files.

## Dry run

The dry run reads Staging schema only. It verifies source/target refs, schema
parity, incoming foreign keys, rollback age, Auth attribution and builds the
transactional restore plan without executing it.

```text
node tools/staging-refresh/cli.mjs dry-run --snapshot=production-snapshot.json --rollback-snapshot=staging-rollback.json --auth-attribution=null
```

`auth-attribution=null` is accepted only for columns that the actual Staging
schema marks nullable. Otherwise use an existing Staging-only Auth actor UUID:

```text
--auth-attribution=staging-actor --staging-actor-id=<uuid>
```

## Restore (future separately authorized operation)

Restore is not part of the current tooling acceptance. When separately
authorized, it requires all of the following and still cannot target Production:

- a separate `STAGING_REFRESH_RESTORE_DATABASE_URL` for the Staging-only
  `staging_refresh_restore_writer` role;
- a rollback snapshot created in the previous 60 minutes;
- `--execute`;
- `--maintenance-ack=STAGING_WRITES_PAUSED`;
- `--approval-snapshot-id=<exact snapshot id>`.

The restore creates temporary tables and replaces only the snapshot's included
Staging tables inside one serializable PostgreSQL transaction. Before commit,
the same database session reads those tables back and compares the prepared
snapshot's counts, ID and row hashes, relationship hashes, Product/Variant
identity and anomaly ID sets. Its schema fingerprint is limited to the same
restore-table scope, so environment-only tables do not create false failures.
A forced error, constraint failure, count/readback mismatch or manifest
integrity failure rolls the entire transaction back. `COMMIT` is sent only
after every integrity check passes.

Schema discovery uses deterministic `pg_catalog` metadata for public tables,
columns, PK/UNIQUE constraints and foreign keys. Reader and writer roles
therefore use one schema contract rather than role-filtered
`information_schema` visibility.

The restore role contract is limited to `SELECT`, `DELETE` and `INSERT` on the
included business tables plus `CREATE TEMP TABLE`. The current SQL does not use
`UPDATE`, `TRUNCATE`, persistent schema `CREATE` / `ALTER` / `DROP`,
`BYPASSRLS`, Production credentials or `service_role`. Snapshot and dry-run
commands do not require the restore writer credential.

## Verify the already-restored Staging data without writes

`verify-only` uses only `STAGING_REFRESH_TARGET_DATABASE_URL`. It applies the
same explicit Auth attribution transformation to the Production snapshot and
compares current Staging using the restore-table schema scope. It never opens a
writer session and performs no database writes:

```text
node tools/staging-refresh/cli.mjs verify-only --snapshot=production-snapshot-pgcat.json --auth-attribution=null
```

Success is reported as `STAGING_VERIFY_ONLY_PASS` with `databaseWrite: 0`.

## Closing Date sidecar

The Workbench sidecar is a NEXT-only browser IndexedDB and is never copied from
Production. Before a real refresh, export each active Staging operator browser's
sidecar for rollback. After the database integrity gate passes, initialize a new
sidecar database/baseline before resuming Closing Date testing. Do not reuse old
verified mappings against a replaced Product identity snapshot.

The operator flow uses `createStagingSidecarRefreshBackup()` followed by
`reinitializeStagingSidecarAfterRefresh()` from
`src/lib/stagingSidecarRefresh.ts`. Reset requires the exact backup SHA-256 and
the newly accepted Product/Variant identity hash. A blocked open database (for
example another Staging tab) fails closed instead of deleting around it.
