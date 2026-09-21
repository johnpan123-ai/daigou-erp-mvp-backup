# 039 — read-only Restore integrity audit candidate

Base: 5488b43cfb51205383b66cbdd67df8ebec7992cf.
No changes to migrations 031–038 or the Restore submit/transaction/state machine.
**Not applied or deployed. Hosted Staging verification remains a separate gate.**

## Boundary and necessity

Endpoint: `public.erp_read_cloud_restore_integrity_audit() → jsonb`.
No arguments (in particular no user-provided table, schema, SQL or snapshot).
The authenticated client makes one manual read RPC through dataProvider. It does
not call PREPARE, BEGIN, EXECUTE, RECONCILE, refresh the cache, or create an attempt.

Uses the existing `auth.uid()` + `public.is_owner(uuid)` OWNER contract.
Anonymous has no EXECUTE; authenticated non-owner is rejected with 42501.
Only the public endpoint grants authenticated EXECUTE. The pure dataset helper
is private. Both are owned by postgres, with fixed
`search_path = pg_catalog, public, extensions`; new catalog contract validation
uses OIDs, argument arrays and structured ACL entries.

SECURITY INVOKER is insufficient for the full audit: 038 attempt RLS deliberately
restricts the caller to their own actor hash. It cannot exclude another OWNER's
prepared/executing attempt. Existing requests have a similar per-actor boundary.
The isolated engine test demonstrates an invisible other-owner executing row
being correctly counted by the audit. Therefore the entrypoint uses a guarded,
fixed-scope SECURITY DEFINER. It exposes only aggregate counts and a whitelisted
latest completed metadata DTO, not business rows, auth UUIDs, actor hashes or
snapshot contents. No RLS/ACL of existing objects is changed.

Runtime is STABLE, with a 30-second **audit-only** timeout. It performs fixed SELECTs
over exactly 15 Restore business tables, attempts, requests, epoch, and backup
existence, plus pg_locks/catalog views. No DML, dynamic SQL, advisory acquisition,
attempt reconciliation or Restore function calls. All business/metadata reads
use the calling statement's MVCC snapshot; locks are necessarily sampled
separately. The existing Restore 120s timeout is unchanged.

## Raw data and canonical hash

Counts include deleted rows, without UI grouping/deduplication. They are never
taken from Settings statistics or IndexedDB. All 15 resources participate.

The old SQL `erp_cloud_restore_relationship_hash` and live SQL helper hash a
different projection/JSON encoding than `cloudAtomicRestore.ts::manifestFor`.
They cannot be substituted for a snapshot-manifest relationship hash.
039 introduces a single private dataset helper implementing that existing
manifest contract: all table rows, canonical lowercase UUID id, the exact
cloudEntityPayload relation fields, compact recursively key-sorted JSON,
table/id ordering, then SHA-256. It does not change the algorithm used by export,
Restore validation or any existing function.

Parity is checked against the real unmodified 9/21 snapshot and the production TS
manifest builder, plus a fixture with populated sales tables, null pointers,
whitespace, escaped characters and Unicode. The 22 blocking/optional relation
specs are checked against `CLOUD_RESTORE_RELATIONS`. Optional missing pointers are
reported separately, not silently counted as valid required relations.

Evidence from **isolated fixtures**, not live target readback:

- 15 raw counts and total: 17,776.
- Relationship hash: d735fe0de5b42684b798493a6928d5936dc5a93ead21d83c022ee9f94f1f7bad.
- Source audit values transformed in fixture: 15,443.
- Target fixture updated_by non-null: 0; null: 17,776.
- Original file SHA remains 5A8E33D49DA3D731CF4D876476A6EB341ACADF7AA50ABF3F971DBAB6FC1DFAA6.

Source transformed count is historical manifest metadata, not the target null
readback. Strict policy does not require all audit identities to be NULL.

## Result and honest verdict

Version: cloud-restore-integrity-audit-v1. Contains audited_at, epoch, table_counts,
total_rows, relationship_hash, all existing manifest anomalies plus
duplicate/missing inventory keys, target audit NULL/non-NULL counts, latest
completed metadata, safe expected manifest counts/hash, and comparison flags.

All owners' prepared/executing counts and processing requests are counted.
pg_locks checks the exact existing maintenance/attempt bigint advisory key
contracts in the current database; it never tries to acquire/release a lock.
The count includes granted and waiting locks (conservative blocked verdict).

Completed metadata coherence requires the current epoch, matching effective
fingerprint, completed request and linked rollback snapshot. Backups have no
rollback-pending lifecycle column; the audit does not fabricate one.
`partial_state` is inconsistent / unproven / not_detected within this scope,
not a universal proof that every price/text/business value matches the source.
Missing completed metadata or absent comparisons cannot yield PASS.
Later legitimate business writes may produce FAIL/mismatch without proving a
partial Restore. UI explicitly says not to automatically retry Restore.

PASS requires exact completed-manifest raw counts/hash, epoch coherence,
zero anomalies, no pending/executing/processing/lock or metadata inconsistency,
and the policy-specific NULL contract. No manifest, incomplete response or read
failure fails closed (PENDING/FAIL). Errors are fixed safe messages, not server
detail. Auth change/unmount discards old responses. Audit results never update
Settings logical statistics or clear drafts/caches.

## Validation and handoff

- `node tests/cloud-restore-integrity-audit-pg.mjs`: actual 039 preflight,
  CREATE, postflight, readonly OWNER execution, denied roles, private ACL,
  schema/collision/ACL guards, anomaly fixtures, other-owner RLS visibility,
  lock observation, epoch incoherence, and unchanged whole-row/metadata hashes.
- Engine: PostgreSQL 18.3 / PGlite 0.5.8, isolated in memory; normalized minimal
  table fixtures, not the entire hosted schema. Hosted PostgreSQL 17.6 Apply and
  actual RLS/data postflight remain PENDING.
- Install the isolated engine outside dependencies if needed:
  `npm install --prefix scratch/restore-audit-pg-runtime --no-save --package-lock=false --ignore-scripts @electric-sql/pglite@0.5.8`.
  Override RESTORE_AUDIT_PGLITE_PATH or RESTORE_AUDIT_SNAPSHOT when necessary.
- `node tests/cloud-restore-integrity-audit-ui.mjs`: real Settings and provider/
  Supabase transport, mocked network only; manual read, double-click suppression,
  raw/logical separation, denied role/local UI, fixed errors and unmount safety.
- Existing targeted Restore re-entry/Settings convergence tests remain relevant;
  no unrelated ERP sweep is required.

Next separately authorized gate: fixed candidate review → 039 Staging Apply once
→ real catalog postflight → deploy this frontend → authenticated OWNER clicks
Audit once. Do not Restore or reconcile to obtain audit evidence.

## Final local validation evidence

All four targeted suites passed: isolated PostgreSQL audit, real Settings audit
transport, Restore re-entry identity, and post-Restore Settings convergence.
TypeScript/build passed. ESLint baseline: existing 65 errors, new errors 0,
new warnings 0, changed-line findings 0. Diff whitespace checks passed.
Build retains the existing Vite future-loader and large-chunk advisories.

039 Git blob: 84e6b9656a71a78aa0dc4860d2f1416d37858c85.
039 SHA-256 (reviewed on-disk artifact):
D777469BBD9826A820B52B7C6333DBADFD79EC0D771C3462CAC9E571D50B53A2.

Final working-source build (parent HEAD above plus this commit's frontend diff):

- Mode: staging; target rhfdjsklfrgpoqsaqpkn.
- Verified public fingerprint: D9EA6B7BB6524517 (no key recorded).
- Entry: assets/index-D84Cszb9.js.
- Provider: assets/dataProvider-DohUGJ2Z.js.
- Local artifact count: 37 (includes control/non-runtime files).
- Manifest SHA-256: EBDC6CF82B376099A9EF6CA11BAA0CF10314FAFCABC8C78201E549200A85F00A.
- Full file/byte/SHA manifest: ignored scratch/recovery-build-evidence.json.
- Backend key/private key/DB-password literal/Postgres URI scan: 0.
- Audit and durable Restore dispatch present; legacy direct Restore dispatch: 0.
- Public config recovered read-only from the established Staging project domain,
  fingerprint checked, injected into only the build child environment.

Staging SQL/migration Apply, Restore, PREPARE/BEGIN/EXECUTE/RECONCILE, deploy,
business write, Production operation, push, cleanup and rollback: **all 0**.
The PostgreSQL fixture setup and candidate Apply occurred only in isolated memory.
