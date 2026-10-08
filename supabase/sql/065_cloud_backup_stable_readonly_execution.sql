begin;

-- 055 is an owner-authorized SELECT-only export. Its default VOLATILE marker
-- forces PostgREST's scalar-result CTE to materialize the whole ~19 MB JSON
-- datum and spill it to temporary storage. Native EXPLAIN of the exact
-- production-scale envelope: 2352 temp blocks before, zero after STABLE.
-- STABLE retains one statement-consistent MVCC view across all 24 resources.
-- Preserve 055's body, ordering, JSON return type, owner gate, ACL and config.
-- No role/global timeout change, resource omission, staging or business write.
alter function public.erp_export_cloud_restore_snapshot_json() stable;

notify pgrst, 'reload schema';

commit;
