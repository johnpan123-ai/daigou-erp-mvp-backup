# ERP 2.0 Deadline Lookup V1 — targeted canonical integration

## Recovery and lineage

- Canonical parent: `346e41ea19f92d1374452c8bec53dd706762dda0`.
- Accepted Restore ancestor: `3089fbcec9e44323522c758059689bb7641d20eb`.
- Pre-task GitHub recovery tag: `backup-20260927-before-erp2-deadline-v1-integration`,
  peeled and remotely verified at the canonical parent BEFORE source editing.
- Integration branch: `codex/erp2-deadline-v1-canonical-integration`.
- Delivery checkpoint: `checkpoint-20260927-erp2-deadline-v1-canonical-integration`.
- Deadline source: `57be78028234f5d4535e6d960997c9ec3bc8ca52` and
  `8ae8842e19d9c08dd8893927957ca2777398af43`.
- No branch merge or whole-file replacement from the older Experimental baseline.
  Before integration, all 14 non-package files touched by that two-commit delta
  matched their pre-Deadline contents in canonical source. Prerequisite source drift = 0.

## Reviewed delta classification

| Class | Files / decision |
| --- | --- |
| A — Product logic | `closingDateBatchGateway.ts`, `closingDateCatalogBatchCache.ts`, `closingDateResolutionDomain.ts`, `proxyProductIdentity.ts`: candidate/direct DTOs, scoped keys, verified-ID batches, status propagation, source identity |
| B — Proxy / Functions | `functions/api/catalog/[[path]].ts`, `functions/catalogProxyRuntime.ts`: existing timeout/abort/error/request-ID machinery retained; explicit Deadline upstream paths added |
| C — Client / Gateway | Same gateway/cache files; `vite.config.ts` shares the production path resolver; `PurchaseRecords.tsx` changes legacy request parameter pageSize to limit only |
| D — Workbench | `ClosingDateResolutionWorkbench.tsx`: direct/candidate metrics, lookup labels, supplier product code and existing verification evidence |
| E — Tests | Proxy reliability, candidate retrieval, cloud parity, Workbench UI, Deadline V1 integration |
| F — Scripts | Only append Deadline and canonical-preservation test commands; preserve every canonical script/dependency |
| G — Already canonical | Cloud closing-date apply adapter, CAS/allowlist, all Restore 041/042/043 transport/proof/UI, environment guards; no older replacement |
| H — Excluded | Experimental environment files/identity/fingerprint, NEXT branch, debug instrumentation, Catalog Worker/Neon experiments, unrelated Restore changes |

## Necessary integration fixes and conflicts

- package.json combined manually: no dependency, lockfile, Restore or release-script rollback.
- The deployment gate previously permitted only the Restore delivery branch. Its approved
  candidate branch now names this isolated integration branch. Accounts, projects, runtime,
  database, fingerprint, accepted LIVE deployment and exact remote-SHA checks are unchanged.
- Cloud parity now runs the real STAGING build mode (sandbox mode null, Cloud provider),
  rather than relying solely on the older Experimental fixture.
- A new deterministic test proved an inherited V1 limit violation: one direct batch plus
  six candidate requests reached physical peak 7 while configured maximum was 6.
  Both caches now receive the SAME existing concurrency gate from the gateway.
  After fix peak = 6. No TTL, retry, timeout, planner budget or ranking changes.
- Restore source and migrations are byte-equivalent after newline normalization to the
  canonical parent; enforced by `tests/erp2-deadline-canonical-preservation.mjs`.

## Contracts

Browser GET /api/catalog/deadline-candidates
→ Pages Functions → Worker /api/catalog/deadline-candidates.

Browser GET /api/catalog/deadlines?catalogProductId=...
→ Pages Functions → Worker /api/catalog/deadlines.

The singular /api/catalog/deadline path is also mapped explicitly.
Legacy /api/catalog/search still maps to Worker /api/search.
No HTML/product-page scraping or image loading is introduced.

Existing Catalog was checked read-only on 2026-09-27:
- candidate route: HTTP 200, schemaVersion deadline-v1, NOT_FOUND / no_candidates;
- direct batch route with a nonexistent UUID: HTTP 200, deadline-v1, NOT_FOUND.
These two safe contract probes prove route availability, NOT correctness of every product
or WAN performance. Catalog modification/deployment = 0.

Cloud analysis performs zero ProductGroup writes. Final manual confirmation uses the
UNCHANGED Cloud apply adapter: only closing_date changes; release_month, product_url,
updated_at and mapping metadata are not patched. Authoritative read + observed CAS guard
remain in place. RED and unconfirmed YELLOW cannot apply. A second candidate remains selectable.

Verified mapping limitation retained from the accepted source: local atomic apply saves
mapping/audit data; the Cloud adapter itself saves ONLY closing_date. Direct lookup works
when an active verified mapping already exists in the local sidecar. This integration
does NOT claim that first Cloud apply persists a new mapping or guarantees direct mode on
the second Cloud analysis. Adding Cloud mapping persistence requires a separate contract.

## Search quality follow-up (not changed)

The exact synthetic ERP title `figma 710 NIKKE 索達：閃亮兔女郎` against
`NIKKE 勝利女神 索達：閃亮兔女郎 1/4 PVC` remains RED:
PRODUCT_TYPE_CONFLICT; zero eligible candidates.
Observed logical queries include `nikke 索達 閃亮兔女郎`, then the broader
`閃亮兔女郎`. figma 710 is not retained by the current planner.
Planner source is unchanged; this is Search Quality follow-up, not silently relaxed matching.

## Regression evidence

Local, isolated fixtures only; no Live ERP writes or Restore.

- Deadline: candidate/direct, 50/51/100/101 chunk boundaries, verified supplier identities,
  manual second selection → direct fixture, no deadline, not found/stale mapping fallback,
  temporary errors not cached, timeout/500/502/abort, consumer cancellation isolation,
  candidate ordering, single/multiple/empty, GREEN/YELLOW/RED, type-conflict case.
- Workbench: cancel, close, history/reopen, late result isolation, no write before confirmation,
  closing_date-only Cloud patch, stale/CAS conflict = zero writes, no automatic retry.
- Actual Cloud fixture in STAGING mode: 1366/1280/390, no Workbench horizontal overflow.
- Restore: durable closure, execute-dispatch evidence, one-click UX, compact card,
  offline reconcile, cache and Settings convergence, full isolated migration chain through 043.
  Observed EXECUTE envelope still 269 bytes; PREPARE 481; 18,059 rows / 15,711 transforms.
- Existing Realtime/Draft catch-up, field CAS/React, Manual Authoritative Refresh,
  mounted content, mutation layout, Japan confirmation/partial receiving,
  agency quantity and Outbound race regressions.
- Canonical identity guard and preservation test; TypeScript; changed-line ESLint; diff check.
  ESLint has inherited findings; acceptance requires zero NEW and zero changed-line findings.
- Restore geometry: idle 183/183/204 px at 1366/1280/390, CTA-to-controls 14 px.
  Existing Restore fixture reports document overflow at 390 outside the card; card overflow is false.
  No layout product code was changed for this integration.

## Performance (fixture, not Live WAN)

Single-item replay: 4 requests, peak 3; multi-candidate median 256.1 ms,
single-candidate 254.5 ms, service-failure 250.8 ms. The sequential comparator is an
isolated fixture, not an actual NEXT measurement. Decisions/order/budget remained equal.

Batch-gateway synthetic 15 ms upstream:

| Items | Logical | Cold upstream | Cold cache | Dedupe | Peak | Cold / warm ms | Warm upstream |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 55 | 33 | 11% | 40% | 6 | 148.4 / 6.7 | 0 |
| 50 | 275 | 93 | 60% | 66% | 6 | 290.3 / 35.6 | 0 |
| 100 | 550 | 168 | 67% | 69% | 6 | 490.7 / 83.0 | 0 |

Cache and dedupe percentages overlap by definition; do not add them.
Native candidate fixture (10 unique titles): 10/50/100 items use 40/200/400 logical
queries, only 40 cold upstream requests in each batch, peak 6, warm upstream 0.
Verified direct fixture: 52 ERP items → 51 unique IDs → chunks 50+1 → 2 requests,
candidate search 0. Mixed direct/candidate jobs share the cap of 6.

## Build / release boundary

STAGING only; target rhfdjsklfrgpoqsaqpkn; fingerprint D9EA6B7BB6524517.
Initial shared dependencies were discovered to differ from package-lock (Vite/React/Supabase).
That trial artifact was rejected. This worktree now has private npm-ci dependencies;
all installed versions match the UNCHANGED lockfile. Final artifact must be generated
from the committed clean candidate and recorded in staging-release-artifacts/frontend-manifest.json.
Expect the locked toolchain's actual chunk count, not the historical shared-toolchain count.

Wrangler skill used for local Functions compilation only, with the already installed 4.141.0.
No deployment or account/config mutation. Functions/routes evidence must accompany frontend.
Official command reference: https://developers.cloudflare.com/workers/wrangler/commands/pages/#pages-functions-build

Git backup commits begin with [CF-Pages-Skip] to avoid triggering Git-connected Pages builds:
https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/
No Cloudflare project/branch setting changes are needed.

Delivery: tests/build → commit/checkpoint → push branch/tag → verify exact remote SHAs.
Deploy, Migration Apply, Restore, Live business write, Catalog/Neon modification = 0.
NEXT/Experimental downstream reconciliation remains a separate future task.
