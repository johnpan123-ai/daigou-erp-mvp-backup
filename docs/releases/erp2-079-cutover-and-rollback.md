# ERP2 079 cutover and rollback

Status: reviewed candidate only. This document does not authorize applying 079, deploying, restoring data, or changing ERP1.

## Required preflight

1. Pause every BuyAnime import/sync/reparse entry point and keep the maintenance window exclusive.
2. Capture a fresh complete ERP2 authoritative backup, its manifest/resource counts and SHA256; verify the restore package remains usable.
3. Reconcile the live database as v33. All earlier effects must be `SATISFIED`, and 079 must be the only `NEEDS_APPLY` effect.
4. Verify the Ledger and current frontend deployment identity, and retain the current deployment as the frontend rollback target.
5. Using an authorized read-only session, require zero rows from:

   ```sql
   begin read only;
   select count(*)::integer as pending_catalog_requests
   from public.erp_idempotency_keys
   where status = 'processing'
     and request_payload ->> 'family' = 'catalog';
   rollback;
   ```

6. Verify the exact approved 079 source checksum. Do not apply when any identity or evidence differs.

The migration itself repeats the critical checks under a fail-closed transaction: it takes a `SHARE NOWAIT` lock on the idempotency table, rejects an incomplete Catalog request, verifies the reviewed 070 predecessor owner/security/search-path and protected implementation anchors, then replaces only `erp_apply_catalog_transaction`.

## Cutover

1. Apply the exact approved 079 once. If the response is unknown or fails, stop and inspect read-only state; do not retry blindly.
2. Verify the 079 effect and candidate schema fingerprint, function owner, ACL, `SECURITY DEFINER`, `search_path`, and unchanged business-data counts.
3. Deploy the exact compatible frontend candidate.
4. Perform the approved smoke checks: import creates Purchase Records without changing Purchase List membership; manual Purchase List add/remove still works; an exact idempotent retry returns the original result.
5. Resume BuyAnime import/sync only after every verification passes.

## Rollback

- Pause imports first and repeat the zero-in-flight check.
- Backend rollback is the exact immutable `erp_apply_catalog_transaction` definition from 070. It changes no existing business rows. Verify the restored v33 function identity and effects before proceeding.
- Frontend rollback must be coordinated with backend rollback. The old frontend is not compatible with 079 because it sends the former paired Purchase List mutation, which 079 correctly rejects.
- Schema rollback is not a business-data restore. Do not restore business data or alter historical Purchase List membership as part of this procedure.
- Any formal rollback requires separate Owner authorization.

Isolation evidence includes applying 079 over v33, reapplying the 070 function over 079, and applying 079 again successfully, with RPC atomicity and idempotency assertions intact.
