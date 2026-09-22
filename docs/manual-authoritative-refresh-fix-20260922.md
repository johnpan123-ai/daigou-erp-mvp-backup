# Manual authoritative refresh — 2026-09-22

Parent: `22cbe893937c70ac658d3d595e82845eface4f7d`.
Branch: `codex/experimental-cloud-atomic-json-restore`.
Checkpoint: `checkpoint-20260922-manual-authoritative-refresh-fix`.
Scope: frontend/cache read path only. No SQL, migration, Restore, deployment or live business mutation.

## Exact break and minimal repair

Both PurchaseRecords and PurchaseManagement rendered “重新載入最新資料” with
`handleReloadData -> loadData -> dataProvider.get*`. The Cloud getters call
`pullCoreProductData()`, whose `isPulled`/existing-promise gate normally reuses
the already-loaded cache. The handler did not request new authority. After its
cached read, `registerFreshLoad()` could also clear the stale/conflict flag without
new server evidence. F5 constructs a new provider/bootstrap, explaining the
different behavior reported by the user. No Live write was used to reproduce it.

The new chain is:

CloudRefreshButton -> existing CloudRealtimeSyncBoundary/coordinator.manualRefresh
-> CloudTargetedCache manual authoritative resource read (all pages)
-> entity-scoped business comparison/draft protection
-> atomic replaceAuthoritativeCloudCollections
-> commit notification -> mounted page read -> React render.

- Uses the same Cloud query/cache queue as Realtime; no second sync architecture,
  forced bootstrap, location.reload, cache clearing or manual full-pull helper.
- Manual read is explicit, not the 15-second throttled incremental focus path.
- One in-flight promise per resource set; the button also has a synchronous
  pending guard, disabled/loading feedback, and safe failure text.
- Commit notifications are distinct from conflict clearance. Read-only consumers
  can reread even if another consumer retains an editing conflict.
- Settings subscribes to product/inventory/sales cache commits. Its existing raw
  Variant statistics and latest-request count gate remain unchanged.
- Cloud cache reads no longer clear true conflicts through registerFreshLoad.
- Editing consumers retain drafts and the original business/CAS baseline. Remote
  changes are recorded as deferred entity conflicts; end-edit catches up through
  the existing targeted mechanism. No silent rebase or stale Save.
- Mouse refresh preserves input focus, avoiding the worksheet's blur autosave.
  Known stale platform-demand saves are blocked before dispatch.
- Refresh-driven PurchaseManagement rereads are read-only and do not run its
  legacy local-cost migration/saveProductVariants side effect.
- Purchase list/detail read generations reject late page reads and invalidate
  on unmount. Cache generations reject older authoritative success/failure.
  Boundary disposal aborts manual reads, preventing old-owner notifications.
- Variant cache comparisons use raw canonical rows, not the SKU-deduped display
  projection; otherwise unchanged hidden canonical rows appear to be new rows.
- The existing button is now available outside the stale-only banner; Settings
  has the same small read-only control next to database statistics.

## Changed files

- src/components/CloudRefreshButton.tsx
- src/contexts/CloudRealtimeSyncContext.tsx
- src/pages/PurchaseManagement.tsx
- src/pages/PurchaseRecords.tsx
- src/pages/Settings.tsx
- src/providers/cloud/cloudSyncDomain.ts
- src/providers/cloud/cloudTargetedCache.ts
- src/providers/dataProvider.ts
- tests/manual-authoritative-refresh.mjs
- tests/fixtures/cloud-p0-2-react-harness.mjs
- tests/cloud-realtime-react-pages.mjs
- this evidence document

The fixture now honors query pagination and getter arguments (including raw).
The existing React stale-blur assertion now expects pre-dispatch protection
without the formerly expected unhandled rejection; it still verifies no write.

## Evidence

All automated scenarios below are isolated/local fixtures, not Live acceptance.

- Real PurchaseManagement button: server-only row change becomes visible in the
  same mounted route without navigation, F5 or any write.
- Real PurchaseRecords summary button: mounted title updates from server state.
- Double click during a held query: one product-group query; loading remains
  visible until read completion; identical data causes no alert.
- Unrelated B update while A has draft 77: cache B updates, A draft/base retained,
  no conflict. Same-value metadata version advances without false conflict.
- Same A business change: draft 77 retained, prior business/CAS base retained,
  true conflict, stale Enter dispatch/writes zero; end-edit displays remote data.
- Failed category read: no partial Variant commit, original UI/cache retained,
  explicit failure and non-fresh status; a later user click can succeed.
- Mounted Settings: 705/390/3254 -> 705/390/3461 after an actual >4-second held
  query and injected existing timeout state -> 706/391/3462 on the next refresh.
  All count rows change from the committed cache; Settings node remains mounted.
  This models timeout state rather than claiming a new Live timeout observation.
- Newer request commits first; older response is superseded. Same-scope manual
  requests share a promise. Disposal aborts and produces no notification.
- Two raw canonical variants sharing a display SKU survive a no-op read without
  a false draft conflict.
- Fixture Live network requests, business writes and fullPulls are zero in the
  new manual suite. No cache clear or page reload is used for its assertions.

Passed commands:

- node tests/manual-authoritative-refresh.mjs
- node tests/realtime-human-acceptance.mjs
- node tests/realtime-refresh-noise.mjs
- node tests/cloud-realtime-draft-catchup.mjs
- node tests/cloud-multi-user-sync.mjs
- node tests/cloud-field-cas.mjs
- node tests/cloud-field-cas-react.mjs
- node tests/cloud-cache-authority.mjs
- node tests/cloud-local-data-isolation.mjs
- node tests/staging-p0-4-realtime-fault-control.mjs
- REALTIME_SKIP_KNOWN_RECENT_PURCHASES=1 node tests/cloud-realtime-react-pages.mjs
- npx tsc -b --pretty false
- P0_ESLINT_BASELINE=22cbe893937c70ac658d3d595e82845eface4f7d node tests/p0-eslint-baseline-delta.mjs
- git diff --check
- npm run build:staging (validated public configuration injected only into child environment)

RecentPurchases date locator: KNOWN BASELINE ISSUE, deliberately excluded and
not counted as PASS. No Restore regression or Live Restore was performed.
Changed-file lint baseline remains 68 errors / 9 warnings; new errors 0,
new warnings 0, changed-line findings 0.
Existing Vite native-config and >500kB chunk advisories remain unchanged.

## Final build

Built from this change's source before commit (the build tool records the parent
HEAD while the worktree is dirty). No runtime source changes followed this build.
The final commit seals these same build inputs, not the parent's old runtime.

- Mode: staging
- Target: rhfdjsklfrgpoqsaqpkn
- Public fingerprint: D9EA6B7BB6524517
- Entry: index-ChOG2CHb.js
- Provider: dataProvider-DrR8wfCV.js
- Files: 37, including deployment control files
- Manifest SHA-256: 073CE6AB23D5DAA97A9DF4A404F02AA9B0E8729CC90B4F42414353B07376EDD1
- Service-role JWT / secret key / Postgres URI findings: 0
- Effective durable Restore dispatch retained; legacy direct effective-wrapper dispatch: 0
- Full asset manifest: ignored local scratch/recovery-build-evidence.json

## Handoff

MANUAL AUTHORITATIVE REFRESH FIX — READY FOR LUNA REVALIDATION.
Next step is fixed-HEAD targeted revalidation, not automatic deployment.
Local commit/checkpoint only. SQL/migrations, Restore, deploy, live business
writes, Production operations, push, cleanup and rollback: all zero.
