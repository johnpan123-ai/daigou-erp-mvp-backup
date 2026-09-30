# ERP2 post-adoption non-schema release lineage

Schema adoption and frontend deployment are separate records. The existing
`BASELINE_ADOPTED` remains historical evidence; this workflow never writes it.
`POST_ADOPTION` now reports `EXACT_BASELINE` or `SAFE_DESCENDANT` in its verified
`deploymentLineage`. Existing canonical schema, freshness, planner, Cloudflare,
remote Git, clean worktree and artifact gates remain required.

## Machine-readable policy

`config/erp2-non-schema-release-policy.json` is default-deny. SQL, providers,
schema/fingerprint tools, DB/identity code, Backup/Restore and unreviewed paths
cannot use the descendant path. Known UI files additionally undergo TypeScript
AST analysis: non-presentation statements and persistence calls must remain
identical. Only the existing read-only WACA loader/error presentation and JSX
may differ. The new availability helper must match its pure predicate exactly.
Package changes permit only new frontend test commands, not changed scripts or
dependencies. Guard-source changes are classified as release control-plane,
not schema; existing target, Git, artifact, freshness and planner verification
functions must remain AST-identical. The deploy wrapper is not allowlisted.

The guard reads actual Git trees, proves baseline ancestry with replacement
objects disabled, checks the baseline checkpoint locally AND on GitHub, compares
every SQL source checksum (including failed/superseded historical migrations),
and compares all canonical schema/fingerprint tools plus the environment
contract byte-for-byte. It does not trust a commit message, file extension,
precomputed classifier claim, or an omitted SQL entry in the diff list.

## Verified original UI candidate

`5cbf5137cb7a2e6fd6244606692feca5ba42521a` to
`8a8564a4155e39be2bcf53a066e6adfe73152503`: 9 non-schema files,
0 schema-sensitive files. Migration and canonical source checksums unchanged.
The final guard-source descendant must be classified again from fixed clean
Git state before deploy; this document does not itself authorize an upload.

## Regression and release sequence

- Exact baseline, actual UI descendant, sidebar and WACA gate positives.
- SQL/RLS/provider/Backup/identity/canonical changes, unknown paths, changed
  RPC payload/quantity code hidden in UI, mutating read loader, impure helper,
  wrong ancestry/checkpoints, and independently changed migration/canonical
  checksums fail closed.
- POST_ADOPTION integration requires fresh matching Live semantic fingerprint,
  valid PASS baseline on the correct project/role, available ledger and zero
  migration delta. Historical execution remains unclaimed.
- Existing wrong-target/artifact/dirty-tree fail-closed tests, WACA Cloud/NEXT
  UI, tab reuse, sync/Realtime/draft/CAS, durable registry and Cloud→NEXT restore
  regressions remain in the focused matrix.
- The SSR-only CAS test harness disables irrelevant HTML dependency discovery
  to prevent its existing background scan/teardown race. CAS assertions and
  product/provider source are unchanged.

Fresh management-authenticated SELECT-only metadata is saved outside version
control. Generate planner evidence against the fixed final HEAD/checkpoint,
rebuild the exact artifact, then hand off to Luna. Only a complete real Guard
PASS permits the existing guarded Pages deploy wrapper. No migration, schema,
baseline, restore or business mutation is part of this release. Postflight must
verify runtime identity, Sidebar/WACA UI, routes and Global Sync before human
acceptance. A failed gate stops the release without bypass or live repair.
