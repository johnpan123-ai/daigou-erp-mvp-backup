# ERP2 Cloud WACA UI / sidebar parity — source closure

Base: `5cbf5137cb7a2e6fd6244606692feca5ba42521a`.
Recovery: `backup-20260930-before-cloud-waca-ui-sidebar-parity-v1` (remote verified).

## Scope

- Shared WACA availability follows NEXT local and ERP2 Cloud/fallback providers.
  The ERP1 project, Local, Test and Experimental remain excluded.
- Sidebar labels/order and BuyAnime title are consistent; routes and role
  policy remain unchanged. The WACA link respects the existing page permission.
- Cloud's real WACA RPC provider was already implemented. Its ledger read/write
  routing is not replaced. The page now exposes it, loading/errors and normal
  zero-row states. Catalog bootstrap precedes the inventory evidence cache read.
- Matcher, quantity, migrations, durable registry, Restore, Deadline and global
  sync source contracts are unchanged.

## Verification

- `test:waca-cloud-ui-parity`: real Cloud/fallback provider routing with an
  isolated synthetic Supabase transport; full page/nav, zero ledger, upload,
  first-load GP evidence, canonical names, changed-only preview, natural SKU
  order, error/retry and role preservation. Repeated tabs: zero reads/writes.
  Widths 1366/1280/390. Test entry is not imported by the production entry.
- `test:next-waca-ui`: local import, all tabs, idempotency, backup/restore,
  injected rollback, multi-tab CAS, manual refresh and those same widths.
- WACA domain, parent evidence, legacy 8→11 and modern restore, 24-table registry,
  Cloud→NEXT parser/isolated rollback, semantic SQL compatibility, promotion
  fail-closed guards, global sync, CAS and Realtime/draft focused regressions.
- Existing `waca-cloud-restore-patch-v3.mjs` executed against a newly created
  loopback-only disposable PostgreSQL 18 cluster: five import replays, four
  injected transaction failures, 24-resource restore rollback and authenticated
  direct-writer denial. No live database was used.
- TypeScript and new/touched WACA files' ESLint pass. AppLayout/Inventory retain
  the base's 37 errors and 2 warnings; changed-line/delta lint adds zero findings.

The default real-file domain fixture references the 2026-09-23 catalog and
2026-09-26 ERP snapshot: 56/60 features, 110/115 rows, four pending historical
features. It is not evidence of the later 60/60 closure. Substituting only the
09-27 catalog with that old ERP snapshot fails the known-G assertion; source
matcher/fixtures were not altered to make incompatible evidence appear green.

## Release gate — must remain fail closed

`scripts/promotion-safety.mjs` POST_ADOPTION currently requires the baseline
ledger's source HEAD and checkpoint to equal the deployment candidate exactly.
The existing adopted baseline refers to the base deployment. A UI-only
descendant cannot be assumed accepted. Luna must verify actual ledger/read-only
evidence and the complete guard before any redeploy. This task forbids baseline
modification and guard bypass; if the existing proof does not cover the new
candidate, stop and report the gate failure. This document is not deployment
approval or proof of a successful postflight.
