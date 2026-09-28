-- Project-owned ERP schema provenance. This is environment-local operational
-- metadata and is intentionally excluded from business Backup/Restore.
begin;

create table if not exists public.erp_schema_migration_ledger (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check(event_type in ('BASELINE_ADOPTED','MIGRATION_APPLIED')),
  event_key text not null check(length(event_key) between 1 and 256),
  source_checksum text not null check(source_checksum~'^[0-9a-f]{64}$'),
  source_head text not null check(source_head~'^[0-9a-f]{40}$'),
  checkpoint text not null check(checkpoint like 'checkpoint-%'),
  schema_fingerprint_before text not null check(schema_fingerprint_before~'^[0-9a-f]{64}$'),
  schema_fingerprint_after text not null check(schema_fingerprint_after~'^[0-9a-f]{64}$'),
  environment_role text not null,
  supabase_project_ref text not null check(supabase_project_ref~'^[a-z]{20}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  recorded_by uuid references auth.users(id) on delete set null,
  result text not null check(result in ('PASS','FAIL')),
  metadata jsonb not null default '{}'::jsonb check(jsonb_typeof(metadata)='object'),
  unique(event_type,event_key,source_checksum,supabase_project_ref)
);
create index if not exists erp_schema_migration_ledger_recorded_at_idx
  on public.erp_schema_migration_ledger(recorded_at desc);
alter table public.erp_schema_migration_ledger enable row level security;
alter table public.erp_schema_migration_ledger force row level security;
drop policy if exists "erp schema ledger owner read" on public.erp_schema_migration_ledger;
create policy "erp schema ledger owner read" on public.erp_schema_migration_ledger
  for select to authenticated using(public.is_owner(auth.uid()));
revoke all on table public.erp_schema_migration_ledger from public,anon,authenticated;
grant select on table public.erp_schema_migration_ledger to authenticated;

create or replace function public.erp_record_schema_migration_event(
  p_event_type text,p_event_key text,p_source_checksum text,p_source_head text,p_checkpoint text,
  p_schema_fingerprint_before text,p_schema_fingerprint_after text,p_environment_role text,
  p_supabase_project_ref text,p_result text,p_metadata jsonb
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,extensions as $$
declare v_actor uuid:=auth.uid(); v_row public.erp_schema_migration_ledger%rowtype;
begin
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode='42501',message='SCHEMA_LEDGER_OWNER_REQUIRED'; end if;
  if p_event_type not in ('BASELINE_ADOPTED','MIGRATION_APPLIED')
     or p_result not in ('PASS','FAIL') or jsonb_typeof(p_metadata) is distinct from 'object' then
    raise exception using errcode='22023',message='SCHEMA_LEDGER_EVENT_INVALID';
  end if;
  if p_event_type='BASELINE_ADOPTED' and coalesce((p_metadata->>'historicalMigrationExecutionClaimed')::boolean,true) then
    raise exception using errcode='22023',message='BASELINE_ADOPTION_CANNOT_CLAIM_MIGRATION_EXECUTION';
  end if;
  insert into public.erp_schema_migration_ledger(
    event_type,event_key,source_checksum,source_head,checkpoint,schema_fingerprint_before,
    schema_fingerprint_after,environment_role,supabase_project_ref,recorded_by,result,metadata
  ) values(
    p_event_type,p_event_key,p_source_checksum,p_source_head,p_checkpoint,p_schema_fingerprint_before,
    p_schema_fingerprint_after,p_environment_role,p_supabase_project_ref,v_actor,p_result,p_metadata
  ) returning * into v_row;
  return jsonb_build_object('id',v_row.id,'eventType',v_row.event_type,'eventKey',v_row.event_key,
    'recordedAt',v_row.recorded_at,'result',v_row.result);
end;
$$;
revoke all on function public.erp_record_schema_migration_event(text,text,text,text,text,text,text,text,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.erp_record_schema_migration_event(text,text,text,text,text,text,text,text,text,text,jsonb)
  to authenticated;

commit;
