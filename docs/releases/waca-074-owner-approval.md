# WACA 21000 — Owner migration approval candidate

ERP2 TESTING / PRE-ADOPTION. ERP1 ABSOLUTE READ ONLY.
Preparation does not authorize live migration, Ledger writes, Restore, WACA confirmation,
push or Cloudflare upload. All database write tests use disposable loopback databases.

## Minimal change

Append `074_waca_counted_state_safeupdate.sql`; never edit/reapply 073.
Only `public.erp_commit_waca_counted_snapshot(jsonb,bigint,jsonb)` changes structurally.
Its signature, owner, grants, search_path, timeout, default ACCUMULATE, recognition
arithmetic, owner/CAS/epoch/Restore-lock checks and transaction boundary are unchanged.
The internal legacy ledger upsert has already advanced revision at the final UPDATE:

```sql
updated_at=v_now, updated_by=v_actor
where id='00000000-0000-4000-8000-000000000001'::uuid and revision=v_revision+1;
get diagnostics v_state_rows = row_count;
if v_state_rows <> 1 then
  raise exception using errcode='23514',message='WACA_COUNTED_STATE_UPDATE_MISMATCH';
end if;
```

23514 expresses a check violation, not a retriable serialization failure. Existing CAS
40001 codes remain unchanged. Diagnostics now receive the actual counted/legacy RPC
from the call path. No matcher, quantity rule, UI design, transport or resource changes.

Live v28: `b66a94b2744874394cdc16996ed7d372633e4a387428fa13ca933e80c33d3601`.
Proposed v29: `8410d8090f11ac1441c803b01d2d364f552fcb07d58386d03463d238f026c1fa`.
`erp2-canonical-schema-v29-waca-counted-state-safeupdate` is a CANDIDATE EXPECTATION,
NOT a cloud-adopted baseline. Historical v28 is not overwritten.
`historicalMigrationExecutionClaimed = false`.
This is a SCHEMA FUNCTION RELEASE, not a UI-only SAFE_DESCENDANT exception.

## Windows evidence and isolation

Finite runner and immutable per-run logs:
`daigou-erp-mvp/scratch/waca-074-repair-20261019/run-windows-gates.mjs`.
Never invoke the persistent Owner preview launcher as an automatic gate or stop port 4740.
Native isolation: PostgreSQL 18.6 / loopback 55492; live PostgreSQL is 17.6.
Upstream pg-safeupdate 1.7 is preloaded before first counted RPC parse on every HTTP
connection; never disabled. Ephemeral test helpers/JWTs never enter migrations/cloud.
The native schema gate proves exactly one function-definition change, unchanged ACL/config,
zero business/epoch/generation mutation and exactly one isolated Apply delta: 074.

The old local PostgREST 13.0.7 retries intentional 40001 conflicts indefinitely. The first
fixed HTTP commit succeeded; the deliberate stale replay was the stalled call. Preserve
those bounded failures; do not extend timeouts. Full rejection tests use the official
PostgREST 16.4 archive, SHA256:
`b47ecc82fce1dcebbbc4183d839e52f07f7630c9d7ad0f54db753d1939299354`.
This test-runtime difference is NOT authorization to upgrade Supabase or change CAS codes.
Before future live negative-CAS tests, establish hosted PostgREST version; do not intentionally
trigger an old-version retry storm. Native CAS is independently tested.
Sources: [Supabase warning](https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b),
[upstream issue](https://github.com/PostgREST/postgrest/issues/3673).

## Execution procedure — only AFTER separate Owner approval

1. Check approved HEAD/checkpoint, migration SHA256 and sealed artifact. Local tags are not
   remote proof. Push only under separately authorized release delivery.
2. Reconfirm live HEAD `66a9fb941f6093377871a158f7c6998f90f2e62f`, artifact
   `62A033F5B94D9BF5E17401D2CA7A4366D662FCC917371A9F18D6F7EB653D9A74`,
   project `rhfdjsklfrgpoqsaqpkn`, existing owner session and no concurrent deployment/write.
3. Capture fresh SELECT-only schema, inventory integrity and ledger using existing tools;
   preserve current 24-resource authoritative Backup and Deadline evidence. Stop if session
   expired or permissions unavailable. Runtime markers are not actual catalog snapshots.
4. Run unchanged `tools/schema-reconciliation/cli.mjs` PRE_ADOPTION against fresh live schema
   and generated target, bound to approved HEAD/checkpoint/v29. Require no blockers/unknown
   differences and exactly one delta: 074. No 073 replay or v28 ledger rewrite in the plan.
5. Hold WACA confirmation, capture all 24 counts/hashes, Revision, Epoch and Generation.
   Apply the checksum-verified 074 ONCE using the established authorized admin workflow.
   Respect BEGIN/COMMIT. If outcome uncertain, inspect schema; never blindly repeat.
6. Immediate SELECT-only postflight: exact counted definition, ACL/search_path and v29
   fingerprint; business hashes/counts, Revision, Epoch and Generation unchanged. Mutation=0.
7. Only after real apply and reconciliation, append actual 074 MIGRATION_APPLIED evidence
   and a NEW v29 BASELINE_ADOPTED event. Never rewrite v28 or claim historical execution.
   These OPS events do not belong to the 24-resource business Backup.
8. Obtain fresh POST_ADOPTION evidence bound to approved candidate/checkpoint/new ledger.
   Run unchanged artifact, remote identity and promotion guards. Before true adoption a
   deployment guard rejection is EXPECTED. Never relabel this schema change UI-only.
9. With separate DEPLOY approval, use existing guarded procedure for account
   `e0a58431cd5bcf0e01ec3438d531461a`, project `hippo-erp-realtime-preview`, branch
   `isolated-preview`: dry-run, exact artifact validation, upload ONCE. Uncertain outcome:
   read Cloudflare deployment status, do not repeat upload.
10. Read-only runtime checks: HTTP200, exact HEAD/artifact/schema/JS/CSS, WACA preview.
    Real WACA confirmation still requires its own Owner authorization. No live synthetic
    writes, Restore, 073 reapply or Ledger v28 rewrite for acceptance.

## Rollback / containment

Pre-commit migration failure rolls back DDL: verify old b66a94b2 and unchanged business
state. Successful 074 remains compatible with old frontend 66a9fb9 (same RPC signature).
If a frontend issue arises, Owner may approve reverting only that frontend deployment;
keep safe 074. Reverting the RPC to 073 restores the P0 defect and is NOT a safe rollback.
No automatic schema downgrade, Ledger deletion, business cleanup or Restore. Unexpected
schema drift needs a separately reviewed forward fix. WACA confirmation stays operationally
paused until approved migration/deploy and Owner acceptance; read-only preview may continue.
