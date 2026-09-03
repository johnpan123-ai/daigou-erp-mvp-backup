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
- Browser Cloud Restore remains disabled.

## Before the first dry run

1. Verify the live Cloudflare Production and Staging project settings.
2. Provision separate read-only Production DB credentials and Staging operator
   credentials. Never use a browser anon key or service-role key in the app.
3. Pause Staging users, importer jobs and Realtime writers.
4. Classify every table listed as `SCHEMA_REVIEW_REQUIRED`. Migrations 018/019
   are not assumed to exist and are not applied automatically.
5. Choose `internal-preserve` only when Staging is restricted to the same
   authorized internal operators. `masked` intentionally remains blocked until
   its field-by-field policy is implemented and accepted.

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

- a rollback snapshot created in the previous 60 minutes;
- `--execute`;
- `--maintenance-ack=STAGING_WRITES_PAUSED`;
- `--approval-snapshot-id=<exact snapshot id>`.

The restore creates temporary tables, validates counts and logical relations,
then replaces included Staging tables inside one serializable PostgreSQL
transaction. A forced error, constraint failure, count mismatch or readback
mismatch rolls the entire transaction back. After commit it creates a fresh
read-only snapshot and compares counts, ID hashes, relationship hashes,
Product/Variant identity and anomaly ID sets.

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
