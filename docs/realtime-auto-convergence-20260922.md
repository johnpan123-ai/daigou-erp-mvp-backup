# Realtime refresh-noise targeted closure

Base: `98a02cc7efb1d288b7df31d41452d07c95e9b633`.
Checkpoint: `checkpoint-20260922-realtime-auto-convergence`.
Offline implementation/revalidation only; deployment and live multi-client acceptance remain pending.

## Trigger chain and reproduced causes

`Supabase postgres_changes -> CloudRealtimeSyncBoundary.handlePayload -> CloudSyncCoordinator -> CloudTargetedCache -> Cloud cache commit -> notifyRefreshed -> useCloudResourceSync -> page load/render`.

Before this patch:

- Cross-tab write markers immediately marked the entire Cloud provider stale. `checkIsStaleLive` re-applied the timestamp decision even after authoritative readback; the marker contained no record/content evidence.
- The coordinator marked any non-local event in an editing **resource** as a conflict before reading the record. Focus/reconnect also conflicted merely because an editor existed.
- Same-value/metadata-only events therefore could not be distinguished from actual draft conflicts. Local echo classification was only a short-lived table/id registry, not proof of equality.
- A follow-up incremental focus read could clear a deferred conflict simply because the conflicting row was absent from that response.
- Per-table single-flight could swallow a newer queued read. Background reads showed the same global loading banner as initial authority acquisition.

## Minimal behavior contract

| Event | Result |
| --- | --- |
| Self echo / same values / duplicate | Authoritative comparison; metadata/version advances, no conflict prompt. Duplicate pending events coalesce. |
| Same-account other client | Actor identity is never an ignore rule; real content changes converge or conflict exactly like other clients. |
| Relevant change, no draft | Targeted read, cache commit, existing mounted consumer notification. |
| Unrelated detail aggregate | Cache may update without interrupting the current draft. Package/shipment/group ownership scopes distinguish known unrelated records. |
| Metadata-only, active draft | Keep draft, advance cached CAS/version; no false conflict. |
| Same-record business change, active draft | Keep original cached business/CAS baseline and draft, retain explicit conflict, block stale save. After edit ends, targeted read applies deferred result. |
| Focus/visibility/reconnect | Existing catch-up path; only authoritative content differences can create a draft conflict. Failure remains fail-closed. |
| Restore epoch | Existing epoch/reconnect handling unchanged; offline epoch-generation replacement regression passes. |

Unknown aggregate membership and collection-wide editor scopes remain conservative; no missing FK is treated as proof that an event is unrelated. `local_id`/canonical mapping is unchanged.

Only metadata (`database_id`, `local_id`, `updated_at`, `updated_by`, `version`, `sync_status`) is excluded from business comparison. Deletion remains a business change. No actor-based suppression, forced freshness, cache clearing or page reload was added.

Realtime cache requests serialize so each queued event gets a read; older numeric versions cannot replace newer cached versions. The non-Realtime authoritative/Restore cache path retains its generation contract.

Outbound detail previously submitted an entire stale page collection when saving one shipment. Because unrelated shipments can now converge while a draft is open, its saves compose other shipments/items from current cache and only submit the current shipment's intent. A route test proves saving A does not revert remote B. Existing save queue/error behavior remains tested.

## Targeted evidence

All tests below are isolated fixtures, not Live acceptance. Fixture network assertions report no Supabase/Production requests. `fullPulls=0` refers only to test instrumentation.

- `tests/realtime-refresh-noise.mjs`: real Outbound route; draft A/remote B, metadata version 3 readback, unchanged reconnect, same-account actual conflict, unrelated event preserving conflict, cancel catch-up, same-account no-draft automatic UI update, A-save/B-preservation, identical self echo, duplicate delivery, queued read ordering and older-version rejection.
- `tests/cloud-realtime-react-pages.mjs` with `REALTIME_SKIP_KNOWN_RECENT_PURCHASES=1`: real primary list/detail pages, Batch/Item CRUD fixture, save/cancel/edit-end, inline second save, blocked stale blur (exact expected error + unchanged server fixture), focus/visibility/reconnect, duplicate delivery, missed insert, first-read failure recovery, atomic parent/item cache commit and registration race.
- RecentPurchases date-toggle locator: **KNOWN BASELINE ISSUE, not PASS**. Explicit opt-in skip isolates it; no RecentPurchases production source change.
- `tests/cloud-realtime-draft-catchup.mjs`, `tests/cloud-multi-user-sync.mjs`: existing coordinator compatibility, no-auto-full-pull, optimistic stale write and edit-end coverage. Their legacy mock mode is supplementary, not a substitute for the new production-mode route test.
- `tests/cloud-canonical-identity-integration.mjs`: canonical key, second save, CAS and reconnect.
- `tests/cloud-field-cas-react.mjs`: real conflict banner and modal draft preservation.
- `tests/cloud-cache-authority.mjs`: four-second fallback then late authoritative commit, empty authority, partial read failure, offline and reconnect.
- `tests/cloud-restore-cache-convergence.mjs`: offline pagination, transaction completion and epoch stale-generation rejection only; no Restore dispatched.
- `tests/cloud-local-data-isolation.mjs`: separate cache namespaces and write guards.
- `tests/staging-p0-4-realtime-fault-control.mjs`: real boundary remove/recreate, missed insert reconnect, failure/diagnostic isolation. Its fake query now implements the already-used pagination `range` API.
- `tests/outbound-receiving-save-race.mjs`: isolated local snapshot, serialized saves, navigation protection, latest state and visible errors; no Live receiving. Requires test-only process environment when invoked outside configured dev mode.
- `tests/cloud-outbound-shipment-provider-integration.mjs`: existing transaction/cache-failure boundary.

TypeScript and final `build:staging`: PASS. Changed-line ESLint compared with the fixed base: no new findings. Existing lint debt and existing Vite native-config/chunk-size warnings are not represented as zero total warnings. `git diff --check`: PASS.

## Final build candidate (not deployed)

- Mode: staging; project: `rhfdjsklfrgpoqsaqpkn`.
- Public fingerprint: `D9EA6B7BB6524517`; recovered from fixed Staging public assets, key not logged or committed.
- Entry: `index-qqNbHpk0.js`.
- Provider: `dataProvider-BL778UD4.js`.
- 37 dist files (including control files; not a claim of 37 runtime assets).
- Manifest SHA-256: `566C0800C75E376F9655F41FA0CD7AF759CEC3F44F9F83E8171AFAE6460FCBB0`.
- Durable effective Restore dispatch retained; legacy direct dispatch absent. Secret scan PASS.
- Build was performed on the candidate working-tree source before commit; the build helper's recorded HEAD is the base, not a claim that the base alone contains these changes.

SQL/migration changes, Apply, Deploy, Push, Live business mutations, Restore/PREPARE/BEGIN/EXECUTE/RECONCILE, Production, cleanup and rollback: **0**.
