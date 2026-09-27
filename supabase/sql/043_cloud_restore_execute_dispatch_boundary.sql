-- 043: close the Browser -> gateway EXECUTE dispatch boundary.
-- Candidate artifact only. Apply only in a separately authorized Staging gate.
-- 042 remains immutable. The legacy payload-carrying EXECUTE RPC stays available
-- for rollback compatibility; new clients prove once and execute by proof id.
begin;

do $restore_dispatch_boundary_preflight$
declare
  v_proof_oid oid:=to_regprocedure('public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)');
  v_execute_oid oid:=to_regprocedure('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)');
  v_business_oid oid:=to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)');
  v_proof record;
  v_execute record;
  v_proof_definition text;
  v_execute_definition text;
begin
  if current_user<>'postgres'
     or to_regrole('authenticated') is null
     or to_regrole('anon') is null
     or to_regprocedure('public.is_owner(uuid)') is null
     or to_regprocedure('public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)') is null
     or to_regprocedure('public.erp_cloud_restore_failure_category(text,text)') is null
     or to_regprocedure('public.erp_cloud_restore_failure_result(uuid)') is null
     or to_regclass('public.erp_cloud_restore_attempts') is null
     or to_regclass('public.erp_cloud_restore_failures') is null
     or to_regclass('public.erp_cloud_restore_epoch') is null
     or v_proof_oid is null or v_execute_oid is null or v_business_oid is null then
    raise exception using errcode='55000',message='CLOUD_RESTORE_DISPATCH_BOUNDARY_BASE_MISSING';
  end if;
  if to_regclass('public.erp_cloud_restore_candidate_proofs') is not null
     or to_regprocedure('public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)') is not null
     or to_regprocedure('public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)') is not null then
    raise exception using errcode='42710',message='CLOUD_RESTORE_DISPATCH_BOUNDARY_COLLISION';
  end if;
  select * into strict v_proof from pg_catalog.pg_proc where oid=v_proof_oid;
  select * into strict v_execute from pg_catalog.pg_proc where oid=v_execute_oid;
  if not v_proof.prosecdef or not v_execute.prosecdef
     or v_proof.proowner<>v_execute.proowner
     or not coalesce(v_proof.proconfig,'{}'::text[]) @> array[
       'search_path=pg_catalog, public, extensions','statement_timeout=120s'
     ]::text[]
     or not coalesce(v_execute.proconfig,'{}'::text[]) @> array[
       'search_path=pg_catalog, public, extensions','statement_timeout=120s'
     ]::text[] then
    raise exception using errcode='55000',message='CLOUD_RESTORE_DISPATCH_BOUNDARY_BASE_SECURITY_MISMATCH';
  end if;
  v_proof_definition:=regexp_replace(lower(pg_get_functiondef(v_proof_oid)),'[[:space:]]+','','g');
  v_execute_definition:=regexp_replace(lower(pg_get_functiondef(v_execute_oid)),'[[:space:]]+','','g');
  if strpos(v_proof_definition,'public.erp_cloud_restore_build_effective_snapshot(')=0
     or strpos(v_proof_definition,'public.erp_cloud_restore_validate_portability(')=0
     or strpos(v_proof_definition,'public.erp_cloud_restore_audit_dataset(')=0
     or strpos(v_execute_definition,$needle$ifv_attempt.status='prepared'then$needle$)=0
     or strpos(v_execute_definition,$needle$setstatus='executing',execution_id=p_execution_id$needle$)=0
     or strpos(v_execute_definition,'insertintopublic.erp_cloud_restore_failures')=0 then
    raise exception using errcode='55000',message='CLOUD_RESTORE_DISPATCH_BOUNDARY_BASE_DEFINITION_MISMATCH';
  end if;
end;
$restore_dispatch_boundary_preflight$;

create table public.erp_cloud_restore_candidate_proofs (
  proof_id uuid primary key default gen_random_uuid(),
  actor_key text not null check(actor_key~'^[0-9a-f]{64}$'),
  source_fingerprint text not null check(source_fingerprint~'^[0-9a-f]{64}$'),
  effective_fingerprint text not null check(effective_fingerprint~'^[0-9a-f]{64}$'),
  restore_policy text not null check(restore_policy in ('strict','cross-environment-audit-null-v1')),
  target_environment text not null check(target_environment='rhfdjsklfrgpoqsaqpkn'),
  restore_mode text not null check(restore_mode in ('strict','cross-environment')),
  source_environment text not null check(length(source_environment) between 1 and 2048),
  effective_snapshot jsonb not null check(jsonb_typeof(effective_snapshot)='object'),
  manifest jsonb not null check(jsonb_typeof(manifest)='object'),
  proof_result jsonb not null check(jsonb_typeof(proof_result)='object'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint erp_cloud_restore_candidate_proofs_expiry_check check(expires_at>created_at)
);
create index erp_cloud_restore_candidate_proofs_expiry_idx
  on public.erp_cloud_restore_candidate_proofs(expires_at);
alter table public.erp_cloud_restore_candidate_proofs enable row level security;
alter table public.erp_cloud_restore_candidate_proofs force row level security;
revoke all on table public.erp_cloud_restore_candidate_proofs from public,anon,authenticated;

create function public.erp_prove_cloud_restore_candidate_v2(
  p_source_snapshot jsonb,
  p_manifest jsonb,
  p_restore_mode text,
  p_source_environment text,
  p_request_id uuid
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public,extensions set statement_timeout='120s' as $$
declare
  v_actor uuid:=auth.uid();
  v_actor_key text;
  v_result jsonb;
  v_effective jsonb;
  v_proof_id uuid;
  v_expires_at timestamptz;
  v_policy text;
  v_target_environment text:='rhfdjsklfrgpoqsaqpkn';
  v_headers jsonb;
  v_header_request_id text;
begin
  raise log 'CLOUD_RESTORE_TRANSPORT request=% rpc=PROOF event=db-entry',p_request_id;
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; end if;
  if p_request_id is null or coalesce(length(p_source_environment),0) not between 1 and 2048 then
    raise exception using errcode='22023',message='CLOUD_RESTORE_PROOF_INPUT_INVALID';
  end if;
  begin
    v_headers:=nullif(current_setting('request.headers',true),'')::jsonb;
  exception when others then
    raise exception using errcode='22023',message='CLOUD_RESTORE_REQUEST_CORRELATION_INVALID';
  end;
  v_header_request_id:=v_headers->>'x-restore-request-id';
  if v_header_request_id is not null and v_header_request_id is distinct from p_request_id::text then
    raise exception using errcode='22023',message='CLOUD_RESTORE_REQUEST_CORRELATION_MISMATCH';
  end if;

  v_result:=public.erp_prove_cloud_restore_candidate(p_source_snapshot,p_manifest,p_restore_mode);
  v_effective:=public.erp_cloud_restore_build_effective_snapshot(p_source_snapshot,p_manifest,p_restore_mode);
  v_actor_key:=encode(digest(v_actor::text,'sha256'),'hex');
  v_policy:=v_result->>'policy';
  delete from public.erp_cloud_restore_candidate_proofs where expires_at<clock_timestamp();
  insert into public.erp_cloud_restore_candidate_proofs(
    actor_key,source_fingerprint,effective_fingerprint,restore_policy,target_environment,
    restore_mode,source_environment,effective_snapshot,manifest,proof_result,expires_at
  ) values(
    v_actor_key,v_result->>'source_fingerprint',v_result->>'effective_fingerprint',v_policy,
    v_target_environment,p_restore_mode,p_source_environment,v_effective,p_manifest,v_result,
    clock_timestamp()+interval '30 minutes'
  ) returning proof_id,expires_at into v_proof_id,v_expires_at;
  raise log 'CLOUD_RESTORE_TRANSPORT request=% rpc=PROOF proof=% event=db-complete',
    p_request_id,v_proof_id;
  return v_result||jsonb_build_object(
    'proof_id',v_proof_id,
    'proof_expires_at',v_expires_at,
    'request_id',p_request_id
  );
end;
$$;
revoke all on function public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid) from public,anon,authenticated;
grant execute on function public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid) to authenticated;

create function public.erp_restore_proven_cloud_snapshot_attempt(
  p_attempt_id uuid,
  p_trace_id uuid,
  p_execution_id uuid,
  p_proof_id uuid,
  p_request_id uuid
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,extensions set statement_timeout='120s' as $$
declare
  v_actor uuid:=auth.uid();
  v_actor_key text;
  v_attempt public.erp_cloud_restore_attempts%rowtype;
  v_proof public.erp_cloud_restore_candidate_proofs%rowtype;
  v_result jsonb;
  v_epoch bigint;
  v_phase text:='PREPARING';
  v_phase_started timestamptz:=clock_timestamp();
  v_state text;
  v_message text;
  v_category text;
  v_headers jsonb;
  v_header_request_id text;
begin
  -- This is the first statement after PL/pgSQL variable initialization. Its
  -- absence proves that Postgres never entered this function/transaction.
  raise log 'CLOUD_RESTORE_TRANSPORT request=% attempt=% trace=% execution=% rpc=EXECUTE event=db-entry',
    p_request_id,p_attempt_id,p_trace_id,p_execution_id;
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode='42501',message='CLOUD_RESTORE_OWNER_REQUIRED'; end if;
  if p_execution_id is null or p_proof_id is null or p_request_id is null then
    raise exception using errcode='22023',message='CLOUD_RESTORE_EXECUTION_ID_REQUIRED';
  end if;
  begin
    v_headers:=nullif(current_setting('request.headers',true),'')::jsonb;
  exception when others then
    raise exception using errcode='22023',message='CLOUD_RESTORE_REQUEST_CORRELATION_INVALID';
  end;
  v_header_request_id:=v_headers->>'x-restore-request-id';
  if v_header_request_id is not null and v_header_request_id is distinct from p_request_id::text then
    raise exception using errcode='22023',message='CLOUD_RESTORE_REQUEST_CORRELATION_MISMATCH';
  end if;
  v_actor_key:=encode(digest(v_actor::text,'sha256'),'hex');
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-attempt:'||p_attempt_id::text,0)) then
    raise exception using errcode='55006',message='CLOUD_RESTORE_ATTEMPT_EXECUTION_CONFLICT';
  end if;
  select * into v_attempt from public.erp_cloud_restore_attempts
    where attempt_id=p_attempt_id and trace_id=p_trace_id and actor_key=v_actor_key for update;
  if not found then raise exception using errcode='22023',message='CLOUD_RESTORE_ATTEMPT_NOT_FOUND'; end if;
  if v_attempt.status='completed' then return v_attempt.canonical_result||jsonb_build_object('replayed',true); end if;
  if v_attempt.status='not_committed' then
    v_result:=public.erp_cloud_restore_failure_result(p_attempt_id);
    if v_result is not null then return v_result; end if;
  end if;
  select * into v_proof from public.erp_cloud_restore_candidate_proofs
    where proof_id=p_proof_id and actor_key=v_actor_key for update;
  if not found then raise exception using errcode='22023',message='CLOUD_RESTORE_PROOF_NOT_FOUND'; end if;
  if v_proof.expires_at<=clock_timestamp() then
    raise exception using errcode='55000',message='CLOUD_RESTORE_PROOF_EXPIRED';
  end if;
  if v_attempt.source_fingerprint is distinct from v_proof.source_fingerprint
     or v_attempt.effective_fingerprint is distinct from v_proof.effective_fingerprint
     or v_attempt.restore_policy is distinct from v_proof.restore_policy
     or v_attempt.target_environment is distinct from v_proof.target_environment
     or v_proof.effective_fingerprint is distinct from v_proof.manifest->>'snapshotFingerprint' then
    raise exception using errcode='22023',message='CLOUD_RESTORE_ATTEMPT_PAYLOAD_MISMATCH';
  end if;
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
  raise log 'CLOUD_RESTORE_ATTEMPT_PHASE request=% attempt=% trace=% execution=% phase=PREPARING event=complete duration_ms=%',
    p_request_id,p_attempt_id,p_trace_id,p_execution_id,
    (extract(epoch from clock_timestamp()-v_phase_started)*1000)::bigint;

  begin
    select epoch into strict v_epoch from public.erp_cloud_restore_epoch where singleton=true;
    if v_epoch is distinct from v_attempt.expected_epoch then
      raise exception using errcode='55000',message='CLOUD_RESTORE_ATTEMPT_EPOCH_MISMATCH';
    end if;
    v_phase:='ATOMIC_RESTORE'; v_phase_started:=clock_timestamp();
    raise log 'CLOUD_RESTORE_ATTEMPT_PHASE request=% attempt=% trace=% execution=% phase=% event=start',
      p_request_id,p_attempt_id,p_trace_id,p_execution_id,v_phase;
    v_result:=public.erp_restore_cloud_snapshot(
      p_attempt_id,v_proof.effective_fingerprint,v_proof.effective_snapshot,
      v_proof.manifest,v_proof.source_environment
    );
    raise log 'CLOUD_RESTORE_ATTEMPT_PHASE request=% attempt=% trace=% execution=% phase=% event=complete duration_ms=%',
      p_request_id,p_attempt_id,p_trace_id,p_execution_id,v_phase,
      (extract(epoch from clock_timestamp()-v_phase_started)*1000)::bigint;
    v_phase:='FINAL_VALIDATION'; v_phase_started:=clock_timestamp();
    if v_result->>'ok' is distinct from 'true'
       or (v_result->>'restoreEpoch')::bigint is distinct from v_attempt.expected_epoch+1 then
      raise exception using errcode='XX000',message='CLOUD_RESTORE_CANONICAL_RESULT_INVALID';
    end if;
    update public.erp_cloud_restore_attempts set status='completed',completed_at=clock_timestamp(),
      result_epoch=(v_result->>'restoreEpoch')::bigint,canonical_result=v_result where attempt_id=p_attempt_id;
    delete from public.erp_cloud_restore_candidate_proofs where proof_id=p_proof_id;
    raise log 'CLOUD_RESTORE_ATTEMPT_PHASE request=% attempt=% trace=% execution=% phase=COMPLETED event=complete duration_ms=%',
      p_request_id,p_attempt_id,p_trace_id,p_execution_id,
      (extract(epoch from clock_timestamp()-v_phase_started)*1000)::bigint;
    return v_result;
  exception when query_canceled or others then
    get stacked diagnostics v_state=returned_sqlstate,v_message=message_text;
    v_category:=public.erp_cloud_restore_failure_category(v_state,v_message);
  end;
  raise log 'CLOUD_RESTORE_ATTEMPT_PHASE request=% attempt=% trace=% execution=% phase=% event=failure sqlstate=% category=%',
    p_request_id,p_attempt_id,p_trace_id,p_execution_id,v_phase,v_state,v_category;
  delete from public.erp_cloud_restore_candidate_proofs where proof_id=p_proof_id;
  insert into public.erp_cloud_restore_failures(
    attempt_id,trace_id,execution_id,phase,category,code,sqlstate,timeout_classification,evidence
  ) values(
    p_attempt_id,p_trace_id,p_execution_id,
    case when v_phase='FINAL_VALIDATION' then 'canonical-result' else 'atomic-restore' end,
    v_category,'CLOUD_RESTORE_FAILURE_'||v_category,v_state,
    case when v_state='57014' then 'query-canceled' else 'not-timeout' end,
    'caught-subtransaction'
  );
  update public.erp_cloud_restore_attempts set status='not_committed',reconciled_at=clock_timestamp()
   where attempt_id=p_attempt_id;
  return public.erp_cloud_restore_failure_result(p_attempt_id);
end;
$$;
revoke all on function public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid) to authenticated;

do $restore_dispatch_boundary_postflight$
declare
  v_proof_oid oid:=to_regprocedure('public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)');
  v_execute_oid oid:=to_regprocedure('public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)');
  v_proof record;
  v_execute record;
  v_definition text;
begin
  if to_regclass('public.erp_cloud_restore_candidate_proofs') is null
     or v_proof_oid is null or v_execute_oid is null then
    raise exception using errcode='55000',message='CLOUD_RESTORE_DISPATCH_BOUNDARY_POSTFLIGHT_MISSING';
  end if;
  select * into strict v_proof from pg_catalog.pg_proc where oid=v_proof_oid;
  select * into strict v_execute from pg_catalog.pg_proc where oid=v_execute_oid;
  if v_proof.proowner<>'postgres'::regrole or v_execute.proowner<>v_proof.proowner
     or not v_proof.prosecdef or not v_execute.prosecdef
     or v_proof.pronargs<>5 or v_execute.pronargs<>5
     or not coalesce(v_proof.proconfig,'{}'::text[]) @> array[
       'search_path=pg_catalog, public, extensions','statement_timeout=120s'
     ]::text[]
     or not coalesce(v_execute.proconfig,'{}'::text[]) @> array[
       'search_path=pg_catalog, public, extensions','statement_timeout=120s'
     ]::text[]
     or has_function_privilege('public',v_proof_oid,'EXECUTE')
     or has_function_privilege('anon',v_proof_oid,'EXECUTE')
     or not has_function_privilege('authenticated',v_proof_oid,'EXECUTE')
     or has_function_privilege('public',v_execute_oid,'EXECUTE')
     or has_function_privilege('anon',v_execute_oid,'EXECUTE')
     or not has_function_privilege('authenticated',v_execute_oid,'EXECUTE')
     or has_table_privilege('public','public.erp_cloud_restore_candidate_proofs','SELECT')
     or has_table_privilege('anon','public.erp_cloud_restore_candidate_proofs','SELECT')
     or has_table_privilege('authenticated','public.erp_cloud_restore_candidate_proofs','SELECT') then
    raise exception using errcode='55000',message='CLOUD_RESTORE_DISPATCH_BOUNDARY_POSTFLIGHT_SECURITY_MISMATCH';
  end if;
  v_definition:=regexp_replace(lower(pg_get_functiondef(v_execute_oid)),'[[:space:]]+','','g');
  if strpos(v_definition,'rpc=executeevent=db-entry')=0
     or strpos(v_definition,'p_proof_id')=0
     or strpos(v_definition,'v_proof.effective_snapshot')=0
     or strpos(v_definition,$needle$ifv_attempt.status='prepared'then$needle$)=0
     or strpos(v_definition,$needle$setstatus='executing',execution_id=p_execution_id$needle$)=0
     or strpos(v_definition,'insertintopublic.erp_cloud_restore_failures')=0
     or strpos(v_definition,$needle$setstatus='completed'$needle$)=0
     or strpos(v_definition,'public.erp_cloud_restore_build_effective_snapshot(')>0 then
    raise exception using errcode='55000',message='CLOUD_RESTORE_DISPATCH_BOUNDARY_POSTFLIGHT_DEFINITION_MISMATCH';
  end if;
end;
$restore_dispatch_boundary_postflight$;

commit;
