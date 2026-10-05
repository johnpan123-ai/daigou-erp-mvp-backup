# ERP1 v1 portable Restore compatibility

The real `cloud-erp-snapshot-2026-10-05-113427.json` (SHA-256
`0048b8b66542d09bbabaad6b7f7741c11f687449d1711cacd6e62e24ef5500e4`)
has 15 shared resources and 18,896 rows. No business snapshot is committed.

Live trace `b1744b9b-6d26-4e42-b7a8-1e570dd3723c` was `not_committed`,
`atomic-restore`, `CLOUD_RESTORE_FAILURE_VALIDATION`, SQLSTATE `22023`,
`caught-subtransaction`; epoch remained 12. The exact file reproduced
`CLOUD_RESTORE_OUTBOUND_TIMESTAMP_EVIDENCE_MISSING` in the 053 internal writer.
All 37 ERP1 outbound rows omit `status_changed_at`. Parse, v1 checksums,
cross-environment proof and prepare had passed. Migration 055 was not involved.

After verifying the original immutable v1 manifest and relationship hash, the
adapter represents absent outbound status history as NULL (033's nullable
column contract). Supplied timestamps remain unchanged. The current manifest
and portability proof are then rebuilt. A current v2 file does not get this
compatibility transform. No SQL, migration, Trigger or permission changes.

Existing legacy policies remain those introduced by the pre-WACA adapter:

- Seven WACA resources: reset supplied ledger/mappings/history to the legacy
  empty dataset and singleton `ORDER_REBASELINE_REQUIRED`, revision 0; shared
  legacy WACA quantities are retained for the later 8→11 replacement rebaseline.
- `import_batches`: empty legacy import history; the v1 format never supplied it.
- `dashboard_category_images`: preserve target associations.
- Deadline browser stores: preserve (no legacy sidecar replacement).
- Baseline/ledger and other environment-local ops metadata: outside business
  Restore; no forged historical execution claims.

These are not newly invented cleanup policies. They are frozen by
`prepareCloudRestoreSnapshot`, `preserveLegacyCloudDashboardImages`,
`CloudAtomicRestorePanel` and the existing Cloud→NEXT / legacy cutover tests.
General target audit defaults only fill fields absent in the old format; every
source-provided business/audit field is compared, apart from the already
accepted cross-environment `updated_by = NULL` transform.

The exact-file native regression takes snapshots through local environment
variables, uses only a disposable loopback PostgreSQL database, and covers
15-resource business/count/active/deleted/UUID parity, current 24-resource
Restore, 37 timestamps, 041/042/043, 269-byte Execute, malformed/version-confused
files, owner/anon boundaries and mid-restore durable failure / full rollback.
The release review uses exact immutable hashes plus an AST check permitting
only the validated-v1 adapter statement. Unknown changes remain fail-closed.

Production Restore remains a user action. The agent never retries it.
