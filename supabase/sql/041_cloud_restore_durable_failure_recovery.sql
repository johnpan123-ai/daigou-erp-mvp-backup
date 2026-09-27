-- Source candidate only. No Live apply is authorized by creating this file.
-- Requires 038/039/040. Business work is a PL/pgSQL subtransaction; failure
-- metadata commits in the outer RPC transaction AFTER that work rolls back.
-- Connection/backend death cannot commit an error record: reconcile must prove
-- non-commit after grace instead, without inventing a SQLSTATE or replaying work.
begin;

do $$
begin
  if to_regclass('public.erp_cloud_restore_attempts') is null
     or to_regclass('public.erp_cloud_restore_requests') is null
     or to_regclass('public.erp_cloud_restore_epoch') is null
     or to_regprocedure('public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)') is null
     or to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)') is null
     or to_regprocedure('public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)') is null
     or to_regprocedure('public.erp_read_cloud_restore_integrity_audit()') is null
     or to_regprocedure('public.erp_reconcile_cloud_restore_attempt(uuid,uuid)') is null
     or to_regprocedure('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)') is null then
    raise exception using errcode='55000', message='CLOUD_RESTORE_FAILURE_BASE_MISSING';
  end if;
end;
$$;

create table public.erp_cloud_restore_failures (
  attempt_id uuid primary key references public.erp_cloud_restore_attempts(attempt_id),
  trace_id uuid not null unique,
  execution_id uuid,
  phase text not null check (phase in ('precheck','builder','atomic-restore','canonical-result','reconcile')),
  category text not null check (category in ('TIMEOUT','VALIDATION','PORTABILITY','CONSTRAINT','AUTHORIZATION','STALE','INTERNAL','UNKNOWN')),
  code text not null check (code = 'CLOUD_RESTORE_FAILURE_' || category),
  sqlstate text check (sqlstate ~ '^[0-9A-Z]{5}$'),
  timeout_classification text not null check (timeout_classification in ('query-canceled','not-timeout','unobserved')),
  evidence text not null check (evidence in ('caught-subtransaction','reconciled-noncommit')),
  failed_at timestamptz not null default clock_timestamp()
);
alter table public.erp_cloud_restore_failures enable row level security;
revoke all on public.erp_cloud_restore_failures from public, anon, authenticated;
grant select on public.erp_cloud_restore_failures to authenticated;
create policy "cloud restore own failure read" on public.erp_cloud_restore_failures
for select to authenticated using (
  public.is_owner(auth.uid()) and exists (
    select 1 from public.erp_cloud_restore_attempts a
    where a.attempt_id=erp_cloud_restore_failures.attempt_id
      and a.actor_key=encode(extensions.digest(auth.uid()::text,'sha256'),'hex')
  )
);

-- Only fixed categories leave this function. Never persist SQLERRM/context/detail.
create function public.erp_cloud_restore_failure_category(p_state text,p_message text)
returns text language sql immutable set search_path=pg_catalog as $$
  select case
    when p_state='57014' then 'TIMEOUT'
    when p_state='42501' then 'AUTHORIZATION'
    when p_message in ('CLOUD_RESTORE_ATTEMPT_EPOCH_MISMATCH','CLOUD_RESTORE_STALE_EPOCH') then 'STALE'
    when p_message like 'CLOUD_RESTORE_PORTABILITY_%' or p_message like 'RESTORE_PORTABILITY_%' then 'PORTABILITY'
    when left(p_state,2)='23' then 'CONSTRAINT'
    when left(p_state,2)='22' then 'VALIDATION'
    when left(p_state,2) in ('XX','42','53','54','58') then 'INTERNAL'
    else 'UNKNOWN' end
$$;
revoke all on function public.erp_cloud_restore_failure_category(text,text) from public,anon,authenticated;

create function public.erp_cloud_restore_failure_result(p_attempt_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object(
    'ok',false,'status','not_committed','attemptId',a.attempt_id,'traceId',a.trace_id,
    'executionId',a.execution_id,'expectedEpoch',a.expected_epoch,'effectiveFingerprint',a.effective_fingerprint,
    'code',f.code,'failure',jsonb_build_object('phase',f.phase,'category',f.category,'code',f.code,
      'sqlstate',f.sqlstate,'timeoutClassification',f.timeout_classification,'evidence',f.evidence,'failedAt',f.failed_at))
  from public.erp_cloud_restore_attempts a join public.erp_cloud_restore_failures f using(attempt_id)
  where a.attempt_id=p_attempt_id and a.status='not_committed'
$$;
revoke all on function public.erp_cloud_restore_failure_result(uuid) from public,anon,authenticated;

create or replace function public.erp_restore_cloud_snapshot_attempt(
  p_attempt_id uuid,p_trace_id uuid,p_execution_id uuid,p_snapshot_fingerprint text,
  p_source_snapshot jsonb,p_manifest jsonb,p_source_environment text,p_restore_mode text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,extensions set statement_timeout='120s' as $$
declare
  v_actor uuid:=auth.uid();
  v_attempt public.erp_cloud_restore_attempts%rowtype;
  v_effective jsonb;
  v_result jsonb;
  v_epoch bigint;
  v_phase text:='precheck';
  v_state text;
  v_message text;
  v_category text;
begin
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-attempt:'||p_attempt_id::text,0)) then
    raise exception using errcode='55006',message='CLOUD_RESTORE_ATTEMPT_EXECUTION_CONFLICT';
  end if;
  select * into v_attempt from public.erp_cloud_restore_attempts
    where attempt_id=p_attempt_id and trace_id=p_trace_id
      and actor_key=encode(digest(v_actor::text,'sha256'),'hex') for update;
  if not found then raise exception using errcode='22023',message='CLOUD_RESTORE_ATTEMPT_NOT_FOUND'; end if;
  if v_attempt.execution_id is distinct from p_execution_id then
    raise exception using errcode='55006',message='CLOUD_RESTORE_ATTEMPT_NOT_EXECUTABLE';
  end if;
  if v_attempt.status='completed' then return v_attempt.canonical_result||jsonb_build_object('replayed',true); end if;
  if v_attempt.status='not_committed' then
    v_result:=public.erp_cloud_restore_failure_result(p_attempt_id);
    if v_result is not null then return v_result; end if;
  end if;
  if v_attempt.status<>'executing' then raise exception using errcode='55006',message='CLOUD_RESTORE_ATTEMPT_NOT_EXECUTABLE'; end if;
  -- A late dispatch may never race an expired-attempt reconciliation.
  if clock_timestamp()>=v_attempt.execution_started_at + (v_attempt.timeout_budget_ms+v_attempt.grace_ms)*interval '1 millisecond' then
    raise exception using errcode='55006',message='CLOUD_RESTORE_ATTEMPT_PENDING';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) then
    raise exception using errcode='55006',message='CLOUD_RESTORE_LOCK_CONFLICT';
  end if;
  -- This exception block is the destructive subtransaction. Its rollback retains
  -- the outer attempt/maintenance locks and local phase, but none of its writes.
  begin
    if v_attempt.effective_fingerprint is distinct from p_snapshot_fingerprint
       or v_attempt.source_fingerprint is distinct from coalesce(p_manifest->'portability'->>'sourceSnapshotFingerprint',p_snapshot_fingerprint)
       or v_attempt.restore_policy is distinct from coalesce(p_manifest->'portability'->>'policyVersion','strict')
       or v_attempt.target_environment is distinct from coalesce(p_manifest->'portability'->>'targetProjectRef','rhfdjsklfrgpoqsaqpkn')
       or p_snapshot_fingerprint is distinct from p_manifest->>'snapshotFingerprint' then
      raise exception using errcode='22023',message='CLOUD_RESTORE_ATTEMPT_PAYLOAD_MISMATCH';
    end if;
    select epoch into strict v_epoch from public.erp_cloud_restore_epoch where singleton=true;
    if v_epoch is distinct from v_attempt.expected_epoch then
      raise exception using errcode='55000',message='CLOUD_RESTORE_ATTEMPT_EPOCH_MISMATCH';
    end if;
    v_phase:='builder';
    v_effective:=public.erp_cloud_restore_build_effective_snapshot(p_source_snapshot,p_manifest,p_restore_mode);
    v_phase:='atomic-restore';
    v_result:=public.erp_restore_cloud_snapshot(p_attempt_id,p_snapshot_fingerprint,v_effective,p_manifest,p_source_environment);
    v_phase:='canonical-result';
    if v_result->>'ok' is distinct from 'true'
       or (v_result->>'restoreEpoch')::bigint is distinct from v_attempt.expected_epoch+1 then
      raise exception using errcode='XX000',message='CLOUD_RESTORE_CANONICAL_RESULT_INVALID';
    end if;
    update public.erp_cloud_restore_attempts set status='completed',completed_at=clock_timestamp(),
      result_epoch=(v_result->>'restoreEpoch')::bigint,canonical_result=v_result where attempt_id=p_attempt_id;
    return v_result;
  exception when query_canceled or others then
    get stacked diagnostics v_state=returned_sqlstate,v_message=message_text;
    v_category:=public.erp_cloud_restore_failure_category(v_state,v_message);
  end;
  -- Do not RAISE after writing: a successful RPC envelope commits the safe failure,
  -- while ok:false explicitly prevents the client from treating it as success.
  insert into public.erp_cloud_restore_failures(attempt_id,trace_id,execution_id,phase,category,code,sqlstate,timeout_classification,evidence)
    values(p_attempt_id,p_trace_id,p_execution_id,v_phase,v_category,'CLOUD_RESTORE_FAILURE_'||v_category,v_state,
      case when v_state='57014' then 'query-canceled' else 'not-timeout' end,'caught-subtransaction');
  update public.erp_cloud_restore_attempts set status='not_committed',reconciled_at=clock_timestamp() where attempt_id=p_attempt_id;
  return public.erp_cloud_restore_failure_result(p_attempt_id);
end;
$$;
revoke all on function public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text) to authenticated;

create or replace function public.erp_reconcile_cloud_restore_attempt(p_attempt_id uuid,p_trace_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions set statement_timeout='10s' as $$
declare
  v_actor uuid:=auth.uid();
  v_attempt public.erp_cloud_restore_attempts%rowtype;
  v_out jsonb;
  v_failure jsonb;
  v_epoch bigint;
  v_fingerprint text;
  v_after timestamptz;
  v_locked boolean;
begin
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; end if;
  -- Nonblocking locks BEFORE FOR UPDATE: an executing RPC must not make this
  -- 10s diagnostic wait on its row for the full 120s restore deadline.
  v_locked:=pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-attempt:'||p_attempt_id::text,0));
  select * into v_attempt from public.erp_cloud_restore_attempts where attempt_id=p_attempt_id
    and trace_id=p_trace_id and actor_key=encode(digest(v_actor::text,'sha256'),'hex');
  if not found then raise exception using errcode='22023',message='CLOUD_RESTORE_ATTEMPT_NOT_FOUND'; end if;
  v_after:=coalesce(v_attempt.execution_started_at,v_attempt.submitted_at)+(v_attempt.timeout_budget_ms+v_attempt.grace_ms)*interval '1 millisecond';
  v_out:=jsonb_build_object('status','pending','attemptId',p_attempt_id,'traceId',p_trace_id,
    'executionId',v_attempt.execution_id,'expectedEpoch',v_attempt.expected_epoch,
    'effectiveFingerprint',v_attempt.effective_fingerprint,'reconcileAfter',v_after);
  if not v_locked then return v_out||jsonb_build_object('reason','active-execution-lock'); end if;
  begin
    select * into strict v_attempt from public.erp_cloud_restore_attempts where attempt_id=p_attempt_id for update nowait;
  exception when lock_not_available then return v_out||jsonb_build_object('reason','active-execution-lock');
  end;
  if v_attempt.status='completed' then
    return v_out||jsonb_build_object('status','completed','resultEpoch',v_attempt.result_epoch,'restoreResult',v_attempt.canonical_result);
  end if;
  if v_attempt.status='not_committed' then
    v_failure:=public.erp_cloud_restore_failure_result(p_attempt_id);
    return coalesce(v_failure,v_out||jsonb_build_object('status','not_committed'));
  end if;
  if v_attempt.status='executing' and clock_timestamp()<v_after then
    return v_out||jsonb_build_object('reason','timeout-grace-active');
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) then
    return v_out||jsonb_build_object('reason','active-execution-lock');
  end if;
  select epoch,snapshot_fingerprint into strict v_epoch,v_fingerprint from public.erp_cloud_restore_epoch where singleton=true;
  if v_epoch is distinct from v_attempt.expected_epoch or v_fingerprint is not distinct from v_attempt.effective_fingerprint
     or exists(select 1 from public.erp_cloud_restore_requests where idempotency_key=p_attempt_id) then
    return v_out||jsonb_build_object('reason','epoch-or-request-ambiguous');
  end if;
  update public.erp_cloud_restore_attempts set status='not_committed',reconciled_at=clock_timestamp() where attempt_id=p_attempt_id;
  insert into public.erp_cloud_restore_failures(attempt_id,trace_id,execution_id,phase,category,code,timeout_classification,evidence)
    values(p_attempt_id,p_trace_id,v_attempt.execution_id,'reconcile','UNKNOWN','CLOUD_RESTORE_FAILURE_UNKNOWN','unobserved','reconciled-noncommit');
  return public.erp_cloud_restore_failure_result(p_attempt_id);
end;
$$;
revoke all on function public.erp_reconcile_cloud_restore_attempt(uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_reconcile_cloud_restore_attempt(uuid,uuid) to authenticated;

do $restore_failure_postflight$
declare
  v_attempt_table_owner oid;
  v_failure_table record;
  v_category_oid oid:=to_regprocedure('public.erp_cloud_restore_failure_category(text,text)');
  v_result_oid oid:=to_regprocedure('public.erp_cloud_restore_failure_result(uuid)');
  v_execute_oid oid:=to_regprocedure('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)');
  v_reconcile_oid oid:=to_regprocedure('public.erp_reconcile_cloud_restore_attempt(uuid,uuid)');
  v_category record;
  v_result record;
  v_execute record;
  v_reconcile record;
  v_execute_definition text;
  v_reconcile_definition text;
begin
  if to_regclass('public.erp_cloud_restore_failures') is null
     or v_category_oid is null or v_result_oid is null
     or v_execute_oid is null or v_reconcile_oid is null then
    raise exception using errcode='55000',message='CLOUD_RESTORE_FAILURE_POSTFLIGHT_MISSING';
  end if;
  select relowner into strict v_attempt_table_owner from pg_catalog.pg_class
    where oid='public.erp_cloud_restore_attempts'::regclass;
  select * into strict v_failure_table from pg_catalog.pg_class
    where oid='public.erp_cloud_restore_failures'::regclass;
  select * into strict v_category from pg_catalog.pg_proc where oid=v_category_oid;
  select * into strict v_result from pg_catalog.pg_proc where oid=v_result_oid;
  select * into strict v_execute from pg_catalog.pg_proc where oid=v_execute_oid;
  select * into strict v_reconcile from pg_catalog.pg_proc where oid=v_reconcile_oid;

  if v_failure_table.relowner<>v_attempt_table_owner or not v_failure_table.relrowsecurity
     or (select count(*) from pg_catalog.pg_policy
         where polrelid='public.erp_cloud_restore_failures'::regclass)<>1
     or has_table_privilege('public','public.erp_cloud_restore_failures','SELECT')
     or has_table_privilege('anon','public.erp_cloud_restore_failures','SELECT')
     or not has_table_privilege('authenticated','public.erp_cloud_restore_failures','SELECT')
     or has_table_privilege('authenticated','public.erp_cloud_restore_failures','INSERT')
     or has_table_privilege('authenticated','public.erp_cloud_restore_failures','UPDATE')
     or has_table_privilege('authenticated','public.erp_cloud_restore_failures','DELETE') then
    raise exception using errcode='55000',message='CLOUD_RESTORE_FAILURE_TABLE_POSTFLIGHT_MISMATCH';
  end if;

  if v_category.proowner<>v_attempt_table_owner or v_category.prosecdef
     or v_category.prorettype<>'text'::regtype or v_category.pronargs<>2
     or v_category.proargtypes[0]<>'text'::regtype or v_category.proargtypes[1]<>'text'::regtype
     or v_category.proargnames is distinct from array['p_state','p_message']::text[]
     or v_category.provolatile<>'i'
     or not coalesce(v_category.proconfig,'{}'::text[]) @> array['search_path=pg_catalog']::text[]
     or v_result.proowner<>v_attempt_table_owner or not v_result.prosecdef
     or v_result.prorettype<>'jsonb'::regtype or v_result.pronargs<>1
     or v_result.proargtypes[0]<>'uuid'::regtype
     or v_result.proargnames is distinct from array['p_attempt_id']::text[]
     or v_result.provolatile<>'s'
     or not coalesce(v_result.proconfig,'{}'::text[]) @> array['search_path=pg_catalog, public']::text[]
     or v_execute.proowner<>v_attempt_table_owner or not v_execute.prosecdef
     or v_execute.prorettype<>'jsonb'::regtype or v_execute.pronargs<>8
     or not coalesce(v_execute.proconfig,'{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]
     or v_reconcile.proowner<>v_attempt_table_owner or not v_reconcile.prosecdef
     or v_reconcile.prorettype<>'jsonb'::regtype or v_reconcile.pronargs<>2
     or not coalesce(v_reconcile.proconfig,'{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=10s']::text[] then
    raise exception using errcode='55000',message='CLOUD_RESTORE_FAILURE_FUNCTION_POSTFLIGHT_MISMATCH';
  end if;

  if has_function_privilege('public',v_category_oid,'EXECUTE')
     or has_function_privilege('anon',v_category_oid,'EXECUTE')
     or has_function_privilege('authenticated',v_category_oid,'EXECUTE')
     or has_function_privilege('public',v_result_oid,'EXECUTE')
     or has_function_privilege('anon',v_result_oid,'EXECUTE')
     or has_function_privilege('authenticated',v_result_oid,'EXECUTE')
     or has_function_privilege('public',v_execute_oid,'EXECUTE')
     or has_function_privilege('anon',v_execute_oid,'EXECUTE')
     or not has_function_privilege('authenticated',v_execute_oid,'EXECUTE')
     or has_function_privilege('public',v_reconcile_oid,'EXECUTE')
     or has_function_privilege('anon',v_reconcile_oid,'EXECUTE')
     or not has_function_privilege('authenticated',v_reconcile_oid,'EXECUTE') then
    raise exception using errcode='55000',message='CLOUD_RESTORE_FAILURE_ACL_POSTFLIGHT_MISMATCH';
  end if;

  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='erp_cloud_restore_failure_category')<>1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='erp_cloud_restore_failure_result')<>1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='erp_restore_cloud_snapshot_attempt')<>1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='erp_reconcile_cloud_restore_attempt')<>1 then
    raise exception using errcode='55000',message='CLOUD_RESTORE_FAILURE_OVERLOAD_COLLISION';
  end if;

  v_execute_definition:=regexp_replace(lower(pg_get_functiondef(v_execute_oid)),'[[:space:]]+','','g');
  v_reconcile_definition:=regexp_replace(lower(pg_get_functiondef(v_reconcile_oid)),'[[:space:]]+','','g');
  if regexp_count(v_execute_definition,'v_result:=public\.erp_restore_cloud_snapshot\(')<>1
     or strpos(v_execute_definition,'exceptionwhenquery_canceledorothersthen')=0
     or strpos(v_execute_definition,'insertintopublic.erp_cloud_restore_failures')=0
     or strpos(v_execute_definition,'exceptionwhenquery_canceledorothersthen')
        >= strpos(v_execute_definition,'insertintopublic.erp_cloud_restore_failures')
     or strpos(v_execute_definition,'returnpublic.erp_cloud_restore_failure_result(p_attempt_id)')=0
     or v_execute_definition ~ '(sqlerrm|pg_exception_detail|pg_exception_context)'
     or strpos(v_reconcile_definition,'active-execution-lock')=0
     or strpos(v_reconcile_definition,'epoch-or-request-ambiguous')=0
     or strpos(v_reconcile_definition,'''reconciled-noncommit''')=0
     or v_reconcile_definition ~ 'erp_restore_cloud_snapshot\(' then
    raise exception using errcode='55000',message='CLOUD_RESTORE_FAILURE_DEFINITION_POSTFLIGHT_MISMATCH';
  end if;
end;
$restore_failure_postflight$;

commit;
