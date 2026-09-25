# Realtime human-acceptance and status-bar fix

## Scope and reproduction

Parent: `d678a48a9cf3ad378d0b18fcb3e258f01fb397a9`.
No migration, Restore implementation, snapshot, Production, or deployed runtime changes.
All event/mutation tests use isolated local fixtures; no Live business writes.

The added real-route test reproduced the parent failure: while `/purchase-records/g-holo`
had an unsaved WACA demand, an item under another group's purchase batch caused one
conflict alert instead of zero. The item has `purchase_batch_id`, not `product_group_id`.
The previous protection predicate treated the missing direct group FK as relevant to
every purchase-group editor. Private-order items and category-linked variants had the
same missing relation issue; inventory/bundle/sales dependencies used a catch-all.
List editors also registered only whole resources, without their edited entity IDs.

Actual chain: Realtime payload -> identity/resource resolution -> coordinator ->
targeted authoritative read -> business comparison -> draft protection -> cache commit
or conflict -> resource notification -> mounted consumer. The fix changes the draft
protection decision, not the visibility of its genuine-conflict notification.

A second source of noise was a fresh background read changing global read readiness to
`loading`. That could disable unrelated saves; the query's reachable notification could
also erase the background-only reason and show a global loading banner. A fresh cache
now remains fresh during an ordinary protected background read. A real failed read,
including failed relation preparation, still fails closed; reconnect/offline initial
readiness and server CAS remain intact.

## Minimal implementation

- `cloudDraftScope.ts`: route/entity scope and cached canonical relations. Resolve
  purchase/private items through their parents, variants through group/category,
  inventory through SKU membership, and bundle/sales dependencies through variants.
  Compare both old and new membership; never classify self by `updated_by`.
  Unknown parent membership remains conservative within the relevant editor scope.
- `CloudRealtimeSyncContext.tsx`: prepare relations once per queued catch-up, inspect
  current editing registrations at commit, and pass explicit scopes from list editors.
- `cloudTargetedCache.ts`: retain fresh readiness during background record reads;
  preparation failures stay in the existing failure path. Keep serialization,
  stale-version protection, business diff, and original conflict baseline protection.
- `PurchaseRecords.tsx`, `JapanPackagesList.tsx`, `OutboundShipmentsList.tsx`: register
  edited IDs rather than making every row in those resources part of the draft.
  Collection-wide import/workbench operations remain conservative.

The old environment bar was fixed outside normal flow, with a 38px shell offset but a
full 100vh main pane. Mobile's fixed header also started at top=0, and independent
Cloud banners occupied the same top coordinates. The new layout reserves real rows
for environment/status banners, then allocates the remaining viewport to the existing
main scroll container. Mobile uses a sticky header inside that container. No guessed
stacked offsets or page reloads are used.

## Evidence

PASS:

- `realtime-human-acceptance.mjs`: real PurchaseManagement route, A draft / B parent
  and item, category-only variant, private item, inventory, bundle and sales relation;
  A remains writable even while B's read is held in flight; two subsequent saves;
  metadata/self echo/duplicate quiet with CAS refreshed; same-owner business conflict
  preserves draft and baseline, blocks stale save, and converges after edit ends;
  no-draft same-owner auto-update; focus/visibility/cross-tab/reconnect quiet;
  unresolved relation scoped conservatively; relation read failure blocks writes.
- Same fixture, real AppLayout: 1366/1280/390px, scroll, route changes, status show/hide,
  environment-bar show/hide, no content overlap, phantom offset, or second document
  scroller. Screenshots visually reviewed at desktop and mobile widths. This is local
  route evidence (experimental fixture label), not a new Staging human acceptance.
- `realtime-refresh-noise.mjs`: real Outbound A/B, same-account changes, draft/cancel,
  metadata version, echo/duplicates, ordering, and saving A does not revert B.
- `cloud-realtime-draft-catchup.mjs`, `cloud-multi-user-sync.mjs`.
- `cloud-realtime-react-pages.mjs`: primary list/detail routes, modal lifecycle,
  incremental/reconnect races, and Batch/Item cache convergence. Run with
  `REALTIME_SKIP_KNOWN_RECENT_PURCHASES=1`: the existing RecentPurchases date locator
  remains KNOWN BASELINE ISSUE, NOT PASS. Its page/fixture was not changed.
- `cloud-field-cas.mjs`, `cloud-field-cas-react.mjs`.
- `cloud-cache-authority.mjs`, `cloud-local-data-isolation.mjs`,
  `staging-p0-4-realtime-fault-control.mjs`.
- TypeScript (`npx tsc -b --pretty false`), changed-line ESLint against parent,
  Staging build, secret scan, and `git diff --check`.

Offline instrumentation: `fullPulls=0`, fixture Supabase requests=0. These are not
Live counters. Real two-client human acceptance remains for the next authorized stage.

## Final local build

Built from the final source changes on the parent before the local commit; only this
evidence document is added afterward. Process-only public configuration was recovered
from the fixed Staging public runtime; no repository environment file was written.

- Mode: staging
- Target: `rhfdjsklfrgpoqsaqpkn`
- Public fingerprint: `D9EA6B7BB6524517`
- Entry: `index-BY7EpQVd.js`
- Provider: `dataProvider-Dm5z7TzJ.js`
- Files: 37 (including deployment control files, not a remote asset count)
- Manifest SHA-256: `D49BFCB6C76FD0D1663443A57DF7DDC24D1DEB7F0B1421DC1C1C39BA58CE69E0`
- Durable effective Restore dispatch retained; direct legacy dispatch absent.
- Secret scan PASS: service-role JWT, secret-key prefix and PostgreSQL URI absent.
- Existing Vite extension/config-loader and large-chunk advisories remain; not fixed
  or suppressed by this task.

## Changed files

Source: `src/components/layout/AppLayout.tsx`,
`src/contexts/CloudRealtimeSyncContext.tsx`, `src/pages/JapanPackagesList.tsx`,
`src/pages/OutboundShipmentsList.tsx`, `src/pages/PurchaseRecords.tsx`,
`src/providers/cloud/cloudDraftScope.ts`, `src/providers/cloud/cloudTargetedCache.ts`,
`src/styles/layout.css`.

Tests: `tests/realtime-human-acceptance.mjs`, `tests/cloud-realtime-draft-catchup.mjs`,
`tests/fixtures/cloud-p0-2-react-harness.mjs` (controllable held targeted read only).
This evidence document is the remaining changed file.

SQL/migration apply or modification, Restore, deployment, Live business writes,
Production operations, push, cleanup and rollback: all zero.
