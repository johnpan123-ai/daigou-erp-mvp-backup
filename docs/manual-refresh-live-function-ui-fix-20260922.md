# Manual refresh: mounted editable routes and visible feedback

## Scope and evidence boundary

- Parent: `b972bf49cfba3fc3e2d099f53254baf2fdfb8f41`.
- Branch: `codex/experimental-cloud-atomic-json-restore`.
- Checkpoint: `checkpoint-20260922-manual-refresh-live-function-ui-fix`.
- User confirmed the failing route was the order record/detail with editing mode enabled.
- Staging's served entry/provider remained `index-ChOG2CHb.js` / `dataProvider-DrR8wfCV.js`; public config matched `rhfdjsklfrgpoqsaqpkn` / fingerprint `D9EA6B7BB6524517`.
- One read-only click on the existing live Settings page showed loading and provider getter rereads. Counts were unchanged (5526 / 707 / 390 / 3472). No newer business data was created for a Live experiment. The browser evidence does not expose a complete HTTP/commit timeline and is not a new-version Live acceptance claim.
- The reported editable detail failure was reproduced in an isolated real React route at the parent before the source fix: enabling editing without changing any field suppressed the new remote variant from the DOM. No live detail route was opened to risk its legacy cost-sync path.

## Exact break and why previous fixtures missed it

`CloudRefreshButton` already dispatched the new manual refresh. It was not merely a stale toast handler. The complete paged candidate and atomic Cloud cache path already existed.

Two later gates were wrong for this route:

1. PurchaseManagement registered `editMode || ...modalFlags` as a draft. A persisted editable switch protected the entire group even when no field had changed, treating a real remote update as conflict instead of refresh.
2. `useCloudResourceSync` dropped committed-cache notifications while `editing`. Even unrelated rows committed into cache were not reread by that mounted editor. The coordinator also discarded the consumer promise, so the button could finish before page reread completed.

F5 re-bootstraps the server cache and mounts/loads the page, bypassing the missed mounted notification. It is not part of this fix.

The old manual test clicked the real button but only tested the **locked/no-draft** detail for updated content. Its getters directly returned fixture cache, so it did not exercise the actual Supabase provider getter/bootstrap layer either. New tests leave editing enabled and bind actual Cloud getters and the native paged query adapter; only the transport is isolated. The fixture now supplies canonical Inventory IDs, as real Cloud rows do, rather than reusing ID-less import rows as RPC responses.

## Minimal implementation

Button click → single-flight coordinator → native authoritative paged reads → complete candidate → atomic `replaceAuthoritativeCloudCollections` → awaited commit listeners → actual provider getters → guarded page state/derived selectors → mounted DOM → success/no-change feedback.

- Editing permission is separated from real worksheet/demand/date/cost drafts and open editor dialogs.
- Only routes that keep drafts separate opt into rereading the **protected** committed cache during editing. Other consumers retain the default draft guard. Conflicting original business/CAS baselines remain protected; fresh unrelated rows can render.
- Locking with an unsaved detail draft now asks before discarding. Declining preserves the draft and conflict. Explicitly accepting releases draft protection and catches up. Refresh itself never discards it.
- Purchasing's previously cache-only error retry now uses authoritative refresh. It gets the same explicit button on the normal/detail view, keeps mounted content during a reread and propagates consumer read failure to the button.
- Authoritative reads report business-content change independently of version/timestamp metadata. No-op refresh says `目前已是最新資料`; conflicts do not claim complete convergence.
- Read/query failure retains the prior complete cache, keeps fail-closed readiness, displays failure and has no automatic retry. Existing generation and single-flight protections remain.
- Refresh rereads on PurchaseManagement keep `readOnly: true`; they do not run its legacy `saveProductVariants` path.

## UI

- Outlined blue border/background, dark readable text, 44px minimum target and fixed minimum width.
- `正在更新…`, disabled state, spinner and textual live status while reads/consumer completion remain pending.
- Separate success, no-change, failure and draft-conflict messages; not color-only.
- Reserved feedback height prevents idle/loading/success jumps.
- Settings uses a scoped single-column mobile grid; desktop card spans cannot create implicit mobile columns or squeeze the button. The runtime status bar implementation itself was not changed.

## Validation

All tests below are isolated; none writes Staging/Production. Fixture server mutations are in-memory.

| Suite | Result / evidence |
| --- | --- |
| `manual-authoritative-refresh.mjs` | PASS: actual Settings, Purchasing selected detail, order overview and editable detail button clicks; same DOM stays mounted |
| Native provider / bootstrap parity | PASS: real Cloud getter/bootstrap and manual paths project the same canonical variant state; no reload on manual route |
| Settings delayed read | PASS: 705/390/3254 → >4s held read + timeout state → 705/390/3461; all-statistics change → 706/391/3462 |
| Consumer completion | PASS: button remains busy after cache commit while route getter is held; success only after reread |
| Draft/CAS | PASS: unrelated draft retained, metadata version advances quietly, true business conflict preserves draft and original CAS base, stale save blocked; explicit discard cancellation retained |
| No-op/failure/race | PASS: no-change feedback; failure no partial cache/false fresh; double click one logical authoritative read; stale generation cannot overwrite newer commit; disposed scope does not notify |
| `realtime-human-acceptance.mjs` | PASS: group-less child scope, unrelated entities, same-owner changes, metadata/CAS, second save, focus/reconnect, unknown relation fail-closed, status-bar layout |
| `realtime-refresh-noise.mjs` | PASS: real Outbound A/B save isolation, draft, self echo/duplicate/no-op, ordering |
| `cloud-realtime-react-pages.mjs` | PASS for exercised routes: Dashboard, Purchasing, overview/detail, Japan Packages and Outbound; draft/modal/catch-up/read-failure/resource-registration races |
| RecentPurchases date locator | KNOWN BASELINE ISSUE; skipped with existing `REALTIME_SKIP_KNOWN_RECENT_PURCHASES=1`, not marked PASS |
| `cloud-realtime-draft-catchup.mjs` | PASS; static assertion updated from unconditional editing skip to explicit protected-reread opt-in and awaited listener |
| `cloud-field-cas.mjs`, `cloud-field-cas-react.mjs` | PASS |
| `cloud-cache-authority.mjs` | PASS: late authoritative timeout race, empty replacement, atomic failure retention |
| `cloud-local-data-isolation.mjs` | PASS |
| Responsive | PASS at 1366 / 1280 / 390: measured text contrast >= 4.5, border >= 2px, height >= 44px, pointer hit target, no status overlap/horizontal Settings overflow/loading shift; screenshots inspected |
| TypeScript | PASS (`tsc -b`, also staging build) |
| ESLint baseline delta | PASS: existing 68 errors / 9 warnings unchanged; new errors 0, new warnings 0, changed-line findings 0 |
| `git diff --check` | PASS |

The route tests exercise genuine local UI interactions, not a JS-only model. They do not substitute for deploying and repeating the user's two-client Live operation.

## Staging build (not deployed)

- Mode: staging; process-only public configuration recovered read-only from the fixed Staging domain and fingerprint-verified.
- Entry: `index-DcxTcHFQ.js`.
- Provider: `dataProvider-BBvvSYw8.js`.
- Files: 37, including the `_redirects` control file (not 37 runtime chunks).
- Manifest SHA-256: `6B8038725CAAA103FEC76944D4212CAA11BA5E398AB50F26380FB3861B8358C8`.
- Target: `rhfdjsklfrgpoqsaqpkn`; public fingerprint: `D9EA6B7BB6524517`.
- Service-role JWT / secret key / Postgres URI candidates: 0. Only the fixed Staging Supabase URL appears as an active project URL.
- Existing effective/durable dispatch remains; legacy direct dispatch 0.
- Existing Vite extension/config-loader advisory and large-chunk advisory remain; no performance redesign.
- Build evidence was generated from this patch before the final commit; no subsequent runtime/build-input changes.

## Changed files

- `src/components/CloudRefreshButton.tsx`, `CloudRefreshButton.css`.
- `src/contexts/CloudRealtimeSyncContext.tsx`.
- `src/providers/cloud/cloudSyncDomain.ts`, `cloudTargetedCache.ts`.
- `src/pages/PurchaseManagement.tsx`, `PurchaseRecords.tsx`, `Purchasing.tsx`, `Settings.tsx`, `Settings.css`.
- `tests/manual-authoritative-refresh.mjs`, `fixtures/cloud-p0-2-react-harness.mjs`.
- `tests/cloud-realtime-draft-catchup.mjs`, `cloud-realtime-react-pages.mjs`, `realtime-human-acceptance.mjs` (awaited notification and explicit draft-discard confirmation contracts).
- This evidence document.

## Operations and handoff

Live manual read-only button clicks = 1 (existing Settings). Live business writes = 0. SQL / migration changes or apply = 0. Restore = 0. Deploy = 0. Production = 0. Push = 0. Cleanup / rollback = 0.

Next: fixed-HEAD Luna revalidation, then separately authorized Staging deployment and user editable-detail two-client acceptance. This candidate is **not** yet deployed.
