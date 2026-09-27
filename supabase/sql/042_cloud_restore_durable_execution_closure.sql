-- Source candidate only. No Live apply is authorized by creating this file.
--
-- 041 could durably record exceptions caught inside the execute RPC, but the
-- attempt had already been committed as `executing` by a separate BEGIN RPC.
-- If the large execute request never reached PostgreSQL, or if PostgREST/the
-- client cancelled the whole execute transaction, no handler in that aborted
-- transaction could commit a failure row and the earlier `executing` marker
-- remained forever.
--
-- 042 keeps backward compatibility for already deployed clients, while new
-- clients dispatch directly from `prepared`. The prepared -> executing change
-- is now part of the same transaction as the destructive work. A whole-RPC
-- abort therefore leaves `prepared`, which the same evidence-based reconcile
-- path can safely close after the bounded grace period. Phase observability is
-- emitted as safe PostgreSQL LOG records because table writes in the atomic
-- transaction would correctly roll back with the business work.
begin;

do $restore_execution_closure_preflight$
declare
  v_execute_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)');
  v_reconcile_oid oid := to_regprocedure('public.erp_reconcile_cloud_restore_attempt(uuid,uuid)');
  v_business_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)');
  v_execute record;
  v_reconcile record;
  v_business_definition text;
begin
  if to_regclass('public.erp_cloud_restore_attempts') is null
     or to_regclass('public.erp_cloud_restore_failures') is null
     or to_regclass('public.erp_cloud_restore_epoch') is null
     or to_regclass('public.erp_cloud_restore_requests') is null
     or v_execute_oid is null or v_reconcile_oid is null
     or to_regprocedure('public.erp_cloud_restore_failure_category(text,text)') is null
     or to_regprocedure('public.erp_cloud_restore_failure_result(uuid)') is null
     or to_regprocedure('public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)') is null
     or v_business_oid is null then
    raise exception using errcode='55000', message='CLOUD_RESTORE_EXECUTION_CLOSURE_BASE_MISSING';
  end if;
  select * into strict v_execute from pg_catalog.pg_proc where oid=v_execute_oid;
  select * into strict v_reconcile from pg_catalog.pg_proc where oid=v_reconcile_oid;
  v_business_definition:=regexp_replace(lower(pg_get_functiondef(v_business_oid)),'[[:space:]]+','','g');
  if not v_execute.prosecdef or not v_reconcile.prosecdef
     or v_execute.proowner<>v_reconcile.proowner
     or not coalesce(v_execute.proconfig,'{}'::text[]) @> array[
       'search_path=pg_catalog, public, extensions','statement_timeout=120s'
     ]::text[]
     or not coalesce(v_reconcile.proconfig,'{}'::text[]) @> array[
       'search_path=pg_catalog, public, extensions','statement_timeout=10s'
     ]::text[]
     or strpos(v_business_definition,'cloud_restore_timingphase=input_validation')=0
     or strpos(v_business_definition,'cloud_restore_timingphase=before_snapshot')=0
     or strpos(v_business_definition,'cloud_restore_timingphase=delete')=0
     or strpos(v_business_definition,'cloud_restore_timingphase=insert')=0
     or strpos(v_business_definition,'cloud_restore_timingphase=integrity')=0
     or strpos(v_business_definition,'cloud_restore_timingphase=epoch_idempotency')=0 then
    raise exception using errcode='55000', message='CLOUD_RESTORE_EXECUTION_CLOSURE_BASE_MISMATCH';
  end if;
end;
$restore_execution_closure_preflight$;

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
  v_phase text:='PREPARING';
  v_phase_started timestamptz:=clock_timestamp();
  v_state text;
  v_message text;
  v_category text;
begin
  raise log 'CLOUD_RESTORE_ATTEMPT_PHASE attempt=% trace=% execution=% phase=% event=start',
    p_attempt_id,p_trace_id,p_execution_id,v_phase;
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; end if;
  if p_execution_id is null then
    raise exception using errcode='22023',message='CLOUD_RESTORE_EXECUTION_ID_REQUIRED';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-attempt:'||p_attempt_id::text,0)) then
    raise exception using errcode='55006',message='CLOUD_RESTORE_ATTEMPT_EXECUTION_CONFLICT';
  end if;
  select * into v_attempt from public.erp_cloud_restore_attempts
    where attempt_id=p_attempt_id and trace_id=p_trace_id
      and actor_key=encode(digest(v_actor::text,'sha256'),'hex') for update;
  if not found then raise exception using errcode='22023',message='CLOUD_RESTORE_ATTEMPT_NOT_FOUND'; end if;
  if v_attempt.status='completed' then return v_attempt.canonical_result||jsonb_build_object('replayed',true); end if;
  if v_attempt.status='not_committed' then
    v_result:=public.erp_cloud_restore_failure_result(p_attempt_id);
    if v_result is not null then return v_result; end if;
  end if;

  -- New clients arrive with a prepared envelope and a client-generated
  -- execution id. This state transition intentionally shares the destructive
  -- transaction: whole-request cancellation rolls it back to prepared.
  if v_attempt.status='prepared' then
    if clock_timestamp()>=v_attempt.submitted_at
       +(v_attempt.timeout_budget_ms+v_attempt.grace_ms)*interval '1 millisecond' then
      raise exception using errcode='55006',message='CLOUD_RESTORE_ATTEMPT_PENDING';
    end if;
    update public.erp_cloud_restore_attempts
       set status='executing',execution_id=p_execution_id,execution_started_at=clock_timestamp()
     where attempt_id=p_attempt_id;
    v_attempt.status:='executing';
    v_attempt.execution_id:=p_execution_id;
    v_attempt.execution_started_at:=clock_timestamp();
  elsif v_attempt.status='executing' then
    -- Backward compatibility for the 038/041 client that called BEGIN first.
    if v_attempt.execution_id is distinct from p_execution_id then
      raise exception using errcode='55006',message='CLOUD_RESTORE_ATTEMPT_NOT_EXECUTABLE';
    end if;
    if clock_timestamp()>=v_attempt.execution_started_at
       +(v_attempt.timeout_budget_ms+v_attempt.grace_ms)*interval '1 millisecond' then
      raise exception using errcode='55006',message='CLOUD_RESTORE_ATTEMPT_PENDING';
    end if;
  else
    raise exception using errcode='55006',message='CLOUD_RESTORE_ATTEMPT_NOT_EXECUTABLE';
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) then
    raise exception using errcode='55006',message='CLOUD_RESTORE_LOCK_CONFLICT';
  end if;
  raise log 'CLOUD_RESTORE_ATTEMPT_PHASE attempt=% trace=% execution=% phase=PREPARING event=complete duration_ms=%',
    p_attempt_id,p_trace_id,p_execution_id,
    (extract(epoch from clock_timestamp()-v_phase_started)*1000)::bigint;

  -- This exception block is the atomic business subtransaction. All business
  -- writes roll back before the outer failure envelope is written.
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

    v_phase:='BUILDING_EFFECTIVE_SNAPSHOT'; v_phase_started:=clock_timestamp();
    raise log 'CLOUD_RESTORE_ATTEMPT_PHASE attempt=% trace=% execution=% phase=% event=start',
      p_attempt_id,p_trace_id,p_execution_id,v_phase;
    v_effective:=public.erp_cloud_restore_build_effective_snapshot(p_source_snapshot,p_manifest,p_restore_mode);
    raise log 'CLOUD_RESTORE_ATTEMPT_PHASE attempt=% trace=% execution=% phase=% event=complete duration_ms=%',
      p_attempt_id,p_trace_id,p_execution_id,v_phase,
      (extract(epoch from clock_timestamp()-v_phase_started)*1000)::bigint;

    -- erp_restore_cloud_snapshot already emits bounded phase timings for input
    -- validation, rollback snapshot, delete, insert, final integrity and epoch.
    -- The global maintenance lock makes these records unambiguous; this outer
    -- record adds attempt/trace/execution correlation without storing payload.
    v_phase:='ATOMIC_RESTORE'; v_phase_started:=clock_timestamp();
    raise log 'CLOUD_RESTORE_ATTEMPT_PHASE attempt=% trace=% execution=% phase=% event=start',
      p_attempt_id,p_trace_id,p_execution_id,v_phase;
    v_result:=public.erp_restore_cloud_snapshot(p_attempt_id,p_snapshot_fingerprint,v_effective,p_manifest,p_source_environment);
    raise log 'CLOUD_RESTORE_ATTEMPT_PHASE attempt=% trace=% execution=% phase=% event=complete duration_ms=%',
      p_attempt_id,p_trace_id,p_execution_id,v_phase,
      (extract(epoch from clock_timestamp()-v_phase_started)*1000)::bigint;

    v_phase:='FINAL_VALIDATION'; v_phase_started:=clock_timestamp();
    if v_result->>'ok' is distinct from 'true'
       or (v_result->>'restoreEpoch')::bigint is distinct from v_attempt.expected_epoch+1 then
      raise exception using errcode='XX000',message='CLOUD_RESTORE_CANONICAL_RESULT_INVALID';
    end if;
    raise log 'CLOUD_RESTORE_ATTEMPT_PHASE attempt=% trace=% execution=% phase=% event=complete duration_ms=%',
      p_attempt_id,p_trace_id,p_execution_id,v_phase,
      (extract(epoch from clock_timestamp()-v_phase_started)*1000)::bigint;

    v_phase:='COMMITTING'; v_phase_started:=clock_timestamp();
    update public.erp_cloud_restore_attempts set status='completed',completed_at=clock_timestamp(),
      result_epoch=(v_result->>'restoreEpoch')::bigint,canonical_result=v_result where attempt_id=p_attempt_id;
    raise log 'CLOUD_RESTORE_ATTEMPT_PHASE attempt=% trace=% execution=% phase=COMPLETED event=complete duration_ms=%',
      p_attempt_id,p_trace_id,p_execution_id,
      (extract(epoch from clock_timestamp()-v_phase_started)*1000)::bigint;
    return v_result;
  exception when query_canceled or others then
    get stacked diagnostics v_state=returned_sqlstate,v_message=message_text;
    v_category:=public.erp_cloud_restore_failure_category(v_state,v_message);
  end;

  raise log 'CLOUD_RESTORE_ATTEMPT_PHASE attempt=% trace=% execution=% phase=% event=failure sqlstate=% category=%',
    p_attempt_id,p_trace_id,p_execution_id,v_phase,v_state,v_category;
  insert into public.erp_cloud_restore_failures(
    attempt_id,trace_id,execution_id,phase,category,code,sqlstate,timeout_classification,evidence
  ) values(
    p_attempt_id,p_trace_id,p_execution_id,
    case
      when v_phase='BUILDING_EFFECTIVE_SNAPSHOT' then 'builder'
      when v_phase='FINAL_VALIDATION' or v_phase='COMMITTING' then 'canonical-result'
      else 'atomic-restore'
    end,
    v_category,'CLOUD_RESTORE_FAILURE_'||v_category,v_state,
    case when v_state='57014' then 'query-canceled' else 'not-timeout' end,
    'caught-subtransaction'
  );
  update public.erp_cloud_restore_attempts
     set status='not_committed',reconciled_at=clock_timestamp()
   where attempt_id=p_attempt_id;
  return public.erp_cloud_restore_failure_result(p_attempt_id);
end;
$$;
revoke all on function public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text) to authenticated;

create or replace function public.erp_reconcile_cloud_restore_attempt(p_attempt_id uuid,p_trace_id uuid)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,extensions set statement_timeout='10s' as $$
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
  v_locked:=pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-attempt:'||p_attempt_id::text,0));
  select * into v_attempt from public.erp_cloud_restore_attempts where attempt_id=p_attempt_id
    and trace_id=p_trace_id and actor_key=encode(digest(v_actor::text,'sha256'),'hex');
  if not found then raise exception using errcode='22023',message='CLOUD_RESTORE_ATTEMPT_NOT_FOUND'; end if;
  v_after:=coalesce(v_attempt.execution_started_at,v_attempt.submitted_at)
    +(v_attempt.timeout_budget_ms+v_attempt.grace_ms)*interval '1 millisecond';
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
  if v_attempt.status in ('prepared','executing') and clock_timestamp()<v_after then
    return v_out||jsonb_build_object('reason','timeout-grace-active');
  end if;
  if v_attempt.status not in ('prepared','executing') then
    return v_out||jsonb_build_object('reason','nonterminal-state-unrecognized');
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0)) then
    return v_out||jsonb_build_object('reason','active-execution-lock');
  end if;
  select epoch,snapshot_fingerprint into strict v_epoch,v_fingerprint
    from public.erp_cloud_restore_epoch where singleton=true;
  if v_epoch is distinct from v_attempt.expected_epoch
     or v_fingerprint is not distinct from v_attempt.effective_fingerprint
     or exists(select 1 from public.erp_cloud_restore_requests where idempotency_key=p_attempt_id) then
    return v_out||jsonb_build_object('reason','epoch-or-request-ambiguous');
  end if;
  update public.erp_cloud_restore_attempts
     set status='not_committed',reconciled_at=clock_timestamp()
   where attempt_id=p_attempt_id;
  insert into public.erp_cloud_restore_failures(
    attempt_id,trace_id,execution_id,phase,category,code,timeout_classification,evidence
  ) values(
    p_attempt_id,p_trace_id,v_attempt.execution_id,'reconcile','UNKNOWN',
    'CLOUD_RESTORE_FAILURE_UNKNOWN','unobserved','reconciled-noncommit'
  );
  raise log 'CLOUD_RESTORE_ATTEMPT_PHASE attempt=% trace=% execution=% phase=RECONCILING event=closed-noncommit prior_status=%',
    p_attempt_id,p_trace_id,v_attempt.execution_id,v_attempt.status;
  return public.erp_cloud_restore_failure_result(p_attempt_id);
end;
$$;
revoke all on function public.erp_reconcile_cloud_restore_attempt(uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_reconcile_cloud_restore_attempt(uuid,uuid) to authenticated;

do $restore_execution_closure_postflight$
declare
  v_execute_oid oid:=to_regprocedure('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)');
  v_reconcile_oid oid:=to_regprocedure('public.erp_reconcile_cloud_restore_attempt(uuid,uuid)');
  v_execute record;
  v_reconcile record;
  v_execute_definition text;
  v_reconcile_definition text;
  v_business_definition text;
begin
  select * into strict v_execute from pg_catalog.pg_proc where oid=v_execute_oid;
  select * into strict v_reconcile from pg_catalog.pg_proc where oid=v_reconcile_oid;
  if v_execute.pronargs<>8 or v_execute.prorettype<>'jsonb'::regtype
     or v_reconcile.pronargs<>2 or v_reconcile.prorettype<>'jsonb'::regtype
     or not v_execute.prosecdef or not v_reconcile.prosecdef
     or not coalesce(v_execute.proconfig,'{}'::text[]) @> array[
       'search_path=pg_catalog, public, extensions','statement_timeout=120s'
     ]::text[]
     or not coalesce(v_reconcile.proconfig,'{}'::text[]) @> array[
       'search_path=pg_catalog, public, extensions','statement_timeout=10s'
     ]::text[]
     or has_function_privilege('public',v_execute_oid,'EXECUTE')
     or has_function_privilege('anon',v_execute_oid,'EXECUTE')
     or not has_function_privilege('authenticated',v_execute_oid,'EXECUTE')
     or has_function_privilege('public',v_reconcile_oid,'EXECUTE')
     or has_function_privilege('anon',v_reconcile_oid,'EXECUTE')
     or not has_function_privilege('authenticated',v_reconcile_oid,'EXECUTE') then
    raise exception using errcode='55000',message='CLOUD_RESTORE_EXECUTION_CLOSURE_POSTFLIGHT_MISMATCH';
  end if;
  v_execute_definition:=regexp_replace(lower(pg_get_functiondef(v_execute_oid)),'[[:space:]]+','','g');
  v_reconcile_definition:=regexp_replace(lower(pg_get_functiondef(v_reconcile_oid)),'[[:space:]]+','','g');
  v_business_definition:=regexp_replace(lower(pg_get_functiondef('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)'::regprocedure)),'[[:space:]]+','','g');
  if strpos(v_execute_definition,$needle$ifv_attempt.status='prepared'then$needle$)=0
     or strpos(v_execute_definition,$needle$setstatus='executing',execution_id=p_execution_id$needle$)=0
     or strpos(v_execute_definition,'cloud_restore_attempt_phase')=0
     or strpos(v_execute_definition,$needle$setstatus='completed'$needle$)=0
     or strpos(v_execute_definition,'insertintopublic.erp_cloud_restore_failures')=0
     or strpos(v_reconcile_definition,$needle$statusin('prepared','executing')$needle$)=0
     or strpos(v_reconcile_definition,$needle$setstatus='not_committed'$needle$)=0
     or strpos(v_reconcile_definition,'epoch-or-request-ambiguous')=0
     or strpos(v_reconcile_definition,'reconciled-noncommit')=0
     or strpos(v_business_definition,'cloud_restore_timingphase=input_validation')=0
     or strpos(v_business_definition,'cloud_restore_timingphase=delete')=0
     or strpos(v_business_definition,'cloud_restore_timingphase=insert')=0
     or strpos(v_business_definition,'cloud_restore_timingphase=integrity')=0 then
    raise exception using errcode='55000',message='CLOUD_RESTORE_EXECUTION_CLOSURE_DEFINITION_MISMATCH';
  end if;
end;
$restore_execution_closure_postflight$;

commit;
