-- Durable Restore attempt envelope for transport-unknown outcome reconciliation.
-- Candidate artifact only. Apply only in a separately authorized Staging gate.
-- 031-037 are immutable history; this migration requires the exact 037 post-state.
begin;

do $restore_attempt_preflight$
declare
  v_legacy_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)');
  v_effective_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text)');
  v_builder_oid oid := to_regprocedure('public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)');
  v_reject_oid oid := to_regprocedure('public.erp_cloud_restore_reject_invalid_portable_row(text)');
  v_legacy record;
  v_effective record;
  v_builder record;
  v_reject record;
  v_effective_definition text;
begin
  if v_legacy_oid is null or v_effective_oid is null or v_builder_oid is null or v_reject_oid is null then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ATTEMPT_BASE_CONTRACT_MISSING';
  end if;
  if to_regclass('public.erp_cloud_restore_attempts') is not null
     or to_regprocedure('public.erp_prepare_cloud_restore_attempt(uuid,uuid,text,text,text,text,integer,text)') is not null
     or to_regprocedure('public.erp_begin_cloud_restore_attempt(uuid,uuid)') is not null
     or to_regprocedure('public.erp_reconcile_cloud_restore_attempt(uuid,uuid)') is not null
     or to_regprocedure('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)') is not null then
    raise exception using errcode = '42710', message = 'CLOUD_RESTORE_ATTEMPT_OBJECT_COLLISION';
  end if;

  select * into v_legacy from pg_catalog.pg_proc where oid = v_legacy_oid;
  select * into v_effective from pg_catalog.pg_proc where oid = v_effective_oid;
  select * into v_builder from pg_catalog.pg_proc where oid = v_builder_oid;
  select * into v_reject from pg_catalog.pg_proc where oid = v_reject_oid;
  if v_legacy.proowner <> v_effective.proowner
     or v_legacy.proowner <> v_builder.proowner
     or v_legacy.proowner <> v_reject.proowner
     or not v_legacy.prosecdef or not v_effective.prosecdef or not v_builder.prosecdef
     or v_reject.prosecdef
     or v_reject.provolatile <> 'v'
     or not coalesce(v_legacy.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]
     or not coalesce(v_effective.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]
     or not coalesce(v_builder.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[] then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ATTEMPT_BASE_SECURITY_MISMATCH';
  end if;
  if has_function_privilege('authenticated', v_legacy_oid, 'EXECUTE')
     or has_function_privilege('public', v_effective_oid, 'EXECUTE')
     or has_function_privilege('anon', v_effective_oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_effective_oid, 'EXECUTE')
     or has_function_privilege('public', v_builder_oid, 'EXECUTE')
     or has_function_privilege('anon', v_builder_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_builder_oid, 'EXECUTE')
     or has_function_privilege('public', v_reject_oid, 'EXECUTE')
     or has_function_privilege('anon', v_reject_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_reject_oid, 'EXECUTE') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ATTEMPT_BASE_ACL_MISMATCH';
  end if;
  v_effective_definition := regexp_replace(lower(pg_get_functiondef(v_effective_oid)), '[[:space:]]+', '', 'g');
  if strpos(v_effective_definition, 'returnpublic.erp_restore_cloud_snapshot(') = 0
     or strpos(v_effective_definition, 'cloud_restore_effective_failure') = 0 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ATTEMPT_BASE_DEFINITION_MISMATCH';
  end if;
end;
$restore_attempt_preflight$;

create table public.erp_cloud_restore_attempts (
  attempt_id uuid primary key,
  trace_id uuid not null unique,
  actor_key text not null check (actor_key ~ '^[0-9a-f]{64}$'),
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  effective_fingerprint text not null check (effective_fingerprint ~ '^[0-9a-f]{64}$'),
  restore_policy text not null check (restore_policy in ('strict','cross-environment-audit-null-v1')),
  target_environment text not null check (target_environment = 'rhfdjsklfrgpoqsaqpkn'),
  expected_epoch bigint not null check (expected_epoch >= 0),
  timeout_budget_ms integer not null check (timeout_budget_ms = 120000),
  timeout_contract_version text not null check (timeout_contract_version = 'postgresql-statement-timeout-v1'),
  grace_ms integer not null default 15000 check (grace_ms = 15000),
  status text not null check (status in ('prepared','executing','completed','not_committed')),
  submitted_at timestamptz not null default clock_timestamp(),
  execution_id uuid,
  execution_started_at timestamptz,
  completed_at timestamptz,
  reconciled_at timestamptz,
  result_epoch bigint,
  canonical_result jsonb,
  constraint erp_cloud_restore_attempt_state_check check (
    (status = 'prepared' and execution_id is null and execution_started_at is null
      and completed_at is null and reconciled_at is null and result_epoch is null and canonical_result is null)
    or (status = 'executing' and execution_id is not null and execution_started_at is not null
      and completed_at is null and reconciled_at is null and result_epoch is null and canonical_result is null)
    or (status = 'completed' and execution_id is not null and execution_started_at is not null
      and completed_at is not null and result_epoch is not null and canonical_result is not null)
    or (status = 'not_committed' and completed_at is null and reconciled_at is not null
      and result_epoch is null and canonical_result is null)
  )
);

create unique index erp_cloud_restore_attempts_active_epoch_uq
  on public.erp_cloud_restore_attempts(actor_key, target_environment, expected_epoch)
  where status in ('prepared','executing');
create unique index erp_cloud_restore_attempts_completed_fingerprint_uq
  on public.erp_cloud_restore_attempts(actor_key, target_environment, effective_fingerprint)
  where status = 'completed';
create index erp_cloud_restore_attempts_status_submitted_idx
  on public.erp_cloud_restore_attempts(status, submitted_at);

alter table public.erp_cloud_restore_attempts enable row level security;
create policy "cloud restore own durable attempt read" on public.erp_cloud_restore_attempts
for select to authenticated using (
  actor_key = encode(extensions.digest(auth.uid()::text, 'sha256'), 'hex')
  and public.is_owner(auth.uid())
);
revoke all on public.erp_cloud_restore_attempts from public, anon, authenticated;
grant select on public.erp_cloud_restore_attempts to authenticated;

create function public.erp_prepare_cloud_restore_attempt(
  p_attempt_id uuid,
  p_trace_id uuid,
  p_source_fingerprint text,
  p_effective_fingerprint text,
  p_restore_policy text,
  p_target_environment text,
  p_timeout_budget_ms integer,
  p_timeout_contract_version text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
set statement_timeout = '10s'
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_key text;
  v_epoch bigint;
  v_existing public.erp_cloud_restore_attempts%rowtype;
  v_completed public.erp_cloud_restore_attempts%rowtype;
  v_request_headers jsonb;
  v_request_host text;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode = '42501', message = 'CLOUD_RESTORE_OWNER_REQUIRED'; end if;
  if p_attempt_id is null or p_trace_id is null
     or p_source_fingerprint is null or p_source_fingerprint !~ '^[0-9a-f]{64}$'
     or p_effective_fingerprint is null or p_effective_fingerprint !~ '^[0-9a-f]{64}$'
     or p_restore_policy is null or p_restore_policy not in ('strict','cross-environment-audit-null-v1')
     or p_target_environment is distinct from 'rhfdjsklfrgpoqsaqpkn'
     or p_timeout_budget_ms is distinct from 120000
     or p_timeout_contract_version is distinct from 'postgresql-statement-timeout-v1' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_ATTEMPT_INVALID';
  end if;
  begin
    v_request_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_ATTEMPT_TARGET_MISMATCH';
  end;
  v_request_host := lower(split_part(coalesce(v_request_headers->>'host', ''), ':', 1));
  if split_part(v_request_host, '.', 1) is distinct from p_target_environment then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_ATTEMPT_TARGET_MISMATCH';
  end if;
  v_actor_key := encode(digest(v_actor::text, 'sha256'), 'hex');
  select epoch into strict v_epoch from public.erp_cloud_restore_epoch where singleton = true;

  select * into v_existing from public.erp_cloud_restore_attempts
   where attempt_id = p_attempt_id and actor_key = v_actor_key;
  if found then
    if v_existing.trace_id is distinct from p_trace_id
       or v_existing.source_fingerprint is distinct from p_source_fingerprint
       or v_existing.effective_fingerprint is distinct from p_effective_fingerprint
       or v_existing.restore_policy is distinct from p_restore_policy
       or v_existing.target_environment is distinct from p_target_environment
       or v_existing.timeout_budget_ms is distinct from p_timeout_budget_ms
       or v_existing.timeout_contract_version is distinct from p_timeout_contract_version then
      raise exception using errcode = '22023', message = 'CLOUD_RESTORE_ATTEMPT_PAYLOAD_MISMATCH';
    end if;
    return jsonb_build_object(
      'status', v_existing.status, 'attemptId', v_existing.attempt_id, 'traceId', v_existing.trace_id,
      'expectedEpoch', v_existing.expected_epoch, 'effectiveFingerprint', v_existing.effective_fingerprint,
      'reconcileAfter', v_existing.submitted_at + (v_existing.timeout_budget_ms + v_existing.grace_ms) * interval '1 millisecond',
      'resultEpoch', v_existing.result_epoch, 'restoreResult', v_existing.canonical_result
    );
  end if;

  select * into v_completed from public.erp_cloud_restore_attempts
   where actor_key = v_actor_key and target_environment = p_target_environment
     and effective_fingerprint = p_effective_fingerprint and status = 'completed';
  if found then
    return jsonb_build_object(
      'status', 'completed', 'attemptId', v_completed.attempt_id, 'traceId', v_completed.trace_id,
      'expectedEpoch', v_completed.expected_epoch, 'effectiveFingerprint', v_completed.effective_fingerprint,
      'reconcileAfter', v_completed.submitted_at + (v_completed.timeout_budget_ms + v_completed.grace_ms) * interval '1 millisecond',
      'resultEpoch', v_completed.result_epoch, 'restoreResult', v_completed.canonical_result
    );
  end if;

  begin
    insert into public.erp_cloud_restore_attempts(
      attempt_id, trace_id, actor_key, source_fingerprint, effective_fingerprint,
      restore_policy, target_environment, expected_epoch, timeout_budget_ms,
      timeout_contract_version, status
    ) values (
      p_attempt_id, p_trace_id, v_actor_key, p_source_fingerprint, p_effective_fingerprint,
      p_restore_policy, p_target_environment, v_epoch, p_timeout_budget_ms,
      p_timeout_contract_version, 'prepared'
    ) returning * into v_existing;
  exception when unique_violation then
    raise exception using errcode = '55006', message = 'CLOUD_RESTORE_ATTEMPT_PENDING';
  end;
  return jsonb_build_object(
    'status', 'prepared', 'attemptId', v_existing.attempt_id, 'traceId', v_existing.trace_id,
    'expectedEpoch', v_existing.expected_epoch, 'effectiveFingerprint', v_existing.effective_fingerprint,
    'reconcileAfter', v_existing.submitted_at + (v_existing.timeout_budget_ms + v_existing.grace_ms) * interval '1 millisecond'
  );
end;
$$;

create function public.erp_begin_cloud_restore_attempt(
  p_attempt_id uuid,
  p_trace_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
set statement_timeout = '10s'
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_key text;
  v_attempt public.erp_cloud_restore_attempts%rowtype;
  v_epoch bigint;
  v_execution_id uuid;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode = '42501', message = 'CLOUD_RESTORE_OWNER_REQUIRED'; end if;
  v_actor_key := encode(digest(v_actor::text, 'sha256'), 'hex');
  select * into v_attempt from public.erp_cloud_restore_attempts
   where attempt_id = p_attempt_id and trace_id = p_trace_id and actor_key = v_actor_key for update;
  if not found then raise exception using errcode = '22023', message = 'CLOUD_RESTORE_ATTEMPT_NOT_FOUND'; end if;
  if v_attempt.status = 'completed' then
    return jsonb_build_object(
      'status','completed','attemptId',v_attempt.attempt_id,'traceId',v_attempt.trace_id,
      'expectedEpoch',v_attempt.expected_epoch,'effectiveFingerprint',v_attempt.effective_fingerprint,
      'resultEpoch',v_attempt.result_epoch,'restoreResult',v_attempt.canonical_result
    );
  end if;
  if v_attempt.status <> 'prepared' then
    raise exception using errcode = '55006', message = 'CLOUD_RESTORE_ATTEMPT_PENDING';
  end if;
  select epoch into strict v_epoch from public.erp_cloud_restore_epoch where singleton = true;
  if v_epoch is distinct from v_attempt.expected_epoch then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ATTEMPT_EPOCH_MISMATCH';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock', 0)) then
    raise exception using errcode = '55006', message = 'CLOUD_RESTORE_LOCK_CONFLICT';
  end if;
  v_execution_id := gen_random_uuid();
  update public.erp_cloud_restore_attempts
     set status = 'executing', execution_id = v_execution_id, execution_started_at = clock_timestamp()
   where attempt_id = v_attempt.attempt_id;
  return jsonb_build_object(
    'status','executing','attemptId',v_attempt.attempt_id,'traceId',v_attempt.trace_id,
    'executionId',v_execution_id,'expectedEpoch',v_attempt.expected_epoch,
    'effectiveFingerprint',v_attempt.effective_fingerprint,
    'reconcileAfter',clock_timestamp() + (v_attempt.timeout_budget_ms + v_attempt.grace_ms) * interval '1 millisecond'
  );
end;
$$;

create function public.erp_restore_cloud_snapshot_attempt(
  p_attempt_id uuid,
  p_trace_id uuid,
  p_execution_id uuid,
  p_snapshot_fingerprint text,
  p_source_snapshot jsonb,
  p_manifest jsonb,
  p_source_environment text,
  p_restore_mode text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
set statement_timeout = '120s'
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_key text;
  v_attempt public.erp_cloud_restore_attempts%rowtype;
  v_effective_snapshot jsonb;
  v_result jsonb;
  v_epoch bigint;
  v_policy text := coalesce(p_manifest->'portability'->>'policyVersion', 'strict');
  v_target text := coalesce(p_manifest->'portability'->>'targetProjectRef', 'rhfdjsklfrgpoqsaqpkn');
  v_source_fingerprint text := coalesce(p_manifest->'portability'->>'sourceSnapshotFingerprint', p_snapshot_fingerprint);
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode = '42501', message = 'CLOUD_RESTORE_OWNER_REQUIRED'; end if;
  v_actor_key := encode(digest(v_actor::text, 'sha256'), 'hex');
  if not pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-attempt:' || p_attempt_id::text, 0)) then
    raise exception using errcode = '55006', message = 'CLOUD_RESTORE_ATTEMPT_EXECUTION_CONFLICT';
  end if;
  select * into v_attempt from public.erp_cloud_restore_attempts
   where attempt_id = p_attempt_id and trace_id = p_trace_id and actor_key = v_actor_key for update;
  if not found then raise exception using errcode = '22023', message = 'CLOUD_RESTORE_ATTEMPT_NOT_FOUND'; end if;
  if v_attempt.status = 'completed' then
    return v_attempt.canonical_result || jsonb_build_object('replayed', true);
  end if;
  if v_attempt.status <> 'executing' or v_attempt.execution_id is distinct from p_execution_id then
    raise exception using errcode = '55006', message = 'CLOUD_RESTORE_ATTEMPT_NOT_EXECUTABLE';
  end if;
  if v_attempt.effective_fingerprint is distinct from p_snapshot_fingerprint
     or v_attempt.source_fingerprint is distinct from v_source_fingerprint
     or v_attempt.restore_policy is distinct from v_policy
     or v_attempt.target_environment is distinct from v_target then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_ATTEMPT_PAYLOAD_MISMATCH';
  end if;
  select epoch into strict v_epoch from public.erp_cloud_restore_epoch where singleton = true;
  if v_epoch is distinct from v_attempt.expected_epoch then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ATTEMPT_EPOCH_MISMATCH';
  end if;
  if p_snapshot_fingerprint is null or p_snapshot_fingerprint !~ '^[0-9a-f]{64}$'
     or p_snapshot_fingerprint is distinct from p_manifest->>'snapshotFingerprint' then
    raise exception using errcode = '22023', message = 'CLOUD_RESTORE_EFFECTIVE_FINGERPRINT_MISMATCH';
  end if;

  v_effective_snapshot := public.erp_cloud_restore_build_effective_snapshot(
    p_source_snapshot, p_manifest, p_restore_mode
  );
  v_result := public.erp_restore_cloud_snapshot(
    p_attempt_id, p_snapshot_fingerprint, v_effective_snapshot, p_manifest, p_source_environment
  );
  update public.erp_cloud_restore_attempts
     set status = 'completed', completed_at = clock_timestamp(),
         result_epoch = (v_result->>'restoreEpoch')::bigint, canonical_result = v_result
   where attempt_id = v_attempt.attempt_id;
  return v_result;
end;
$$;

create function public.erp_reconcile_cloud_restore_attempt(
  p_attempt_id uuid,
  p_trace_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
set statement_timeout = '10s'
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_key text;
  v_attempt public.erp_cloud_restore_attempts%rowtype;
  v_epoch bigint;
  v_epoch_fingerprint text;
  v_global_lock boolean;
  v_attempt_lock boolean;
  v_reconcile_after timestamptz;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if not public.is_owner(v_actor) then raise exception using errcode = '42501', message = 'CLOUD_RESTORE_OWNER_REQUIRED'; end if;
  v_actor_key := encode(digest(v_actor::text, 'sha256'), 'hex');
  select * into v_attempt from public.erp_cloud_restore_attempts
   where attempt_id = p_attempt_id and trace_id = p_trace_id and actor_key = v_actor_key for update;
  if not found then raise exception using errcode = '22023', message = 'CLOUD_RESTORE_ATTEMPT_NOT_FOUND'; end if;
  v_reconcile_after := coalesce(v_attempt.execution_started_at, v_attempt.submitted_at)
    + (v_attempt.timeout_budget_ms + v_attempt.grace_ms) * interval '1 millisecond';
  if v_attempt.status = 'completed' then
    return jsonb_build_object(
      'status','completed','attemptId',v_attempt.attempt_id,'traceId',v_attempt.trace_id,
      'expectedEpoch',v_attempt.expected_epoch,'effectiveFingerprint',v_attempt.effective_fingerprint,
      'resultEpoch',v_attempt.result_epoch,'reconcileAfter',v_reconcile_after,
      'restoreResult',v_attempt.canonical_result
    );
  end if;
  if v_attempt.status = 'not_committed' then
    return jsonb_build_object(
      'status','not_committed','attemptId',v_attempt.attempt_id,'traceId',v_attempt.trace_id,
      'expectedEpoch',v_attempt.expected_epoch,'effectiveFingerprint',v_attempt.effective_fingerprint,
      'reconcileAfter',v_reconcile_after
    );
  end if;
  if v_attempt.status = 'prepared' then
    update public.erp_cloud_restore_attempts
       set status = 'not_committed', reconciled_at = clock_timestamp()
     where attempt_id = v_attempt.attempt_id;
    return jsonb_build_object(
      'status','not_committed','attemptId',v_attempt.attempt_id,'traceId',v_attempt.trace_id,
      'expectedEpoch',v_attempt.expected_epoch,'effectiveFingerprint',v_attempt.effective_fingerprint,
      'reconcileAfter',v_reconcile_after
    );
  end if;
  if clock_timestamp() < v_reconcile_after then
    return jsonb_build_object(
      'status','pending','reason','timeout-grace-active','attemptId',v_attempt.attempt_id,'traceId',v_attempt.trace_id,
      'expectedEpoch',v_attempt.expected_epoch,'effectiveFingerprint',v_attempt.effective_fingerprint,
      'reconcileAfter',v_reconcile_after
    );
  end if;
  select epoch, snapshot_fingerprint into strict v_epoch, v_epoch_fingerprint
    from public.erp_cloud_restore_epoch where singleton = true;
  if v_epoch is distinct from v_attempt.expected_epoch
     or v_epoch_fingerprint is not distinct from v_attempt.effective_fingerprint then
    return jsonb_build_object(
      'status','pending','reason','epoch-or-fingerprint-ambiguous','attemptId',v_attempt.attempt_id,
      'traceId',v_attempt.trace_id,'expectedEpoch',v_attempt.expected_epoch,
      'effectiveFingerprint',v_attempt.effective_fingerprint,'reconcileAfter',v_reconcile_after
    );
  end if;
  v_global_lock := pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock', 0));
  v_attempt_lock := pg_try_advisory_xact_lock(hashtextextended('erp-cloud-restore-attempt:' || v_attempt.attempt_id::text, 0));
  if not v_global_lock or not v_attempt_lock then
    return jsonb_build_object(
      'status','pending','reason','active-execution-lock','attemptId',v_attempt.attempt_id,
      'traceId',v_attempt.trace_id,'expectedEpoch',v_attempt.expected_epoch,
      'effectiveFingerprint',v_attempt.effective_fingerprint,'reconcileAfter',v_reconcile_after
    );
  end if;
  update public.erp_cloud_restore_attempts
     set status = 'not_committed', reconciled_at = clock_timestamp()
   where attempt_id = v_attempt.attempt_id;
  return jsonb_build_object(
    'status','not_committed','attemptId',v_attempt.attempt_id,'traceId',v_attempt.trace_id,
    'expectedEpoch',v_attempt.expected_epoch,'effectiveFingerprint',v_attempt.effective_fingerprint,
    'reconcileAfter',v_reconcile_after
  );
end;
$$;

revoke all on function public.erp_prepare_cloud_restore_attempt(uuid,uuid,text,text,text,text,integer,text) from public, anon;
revoke all on function public.erp_begin_cloud_restore_attempt(uuid,uuid) from public, anon;
revoke all on function public.erp_reconcile_cloud_restore_attempt(uuid,uuid) from public, anon;
revoke all on function public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text) from public, anon;
grant execute on function public.erp_prepare_cloud_restore_attempt(uuid,uuid,text,text,text,text,integer,text) to authenticated;
grant execute on function public.erp_begin_cloud_restore_attempt(uuid,uuid) to authenticated;
grant execute on function public.erp_reconcile_cloud_restore_attempt(uuid,uuid) to authenticated;
grant execute on function public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text) to authenticated;
revoke all on function public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text) from authenticated;

do $restore_attempt_postflight$
declare
  v_legacy_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)');
  v_old_effective_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text)');
  v_prepare_oid oid := to_regprocedure('public.erp_prepare_cloud_restore_attempt(uuid,uuid,text,text,text,text,integer,text)');
  v_begin_oid oid := to_regprocedure('public.erp_begin_cloud_restore_attempt(uuid,uuid)');
  v_reconcile_oid oid := to_regprocedure('public.erp_reconcile_cloud_restore_attempt(uuid,uuid)');
  v_attempt_restore_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)');
  v_legacy_owner oid;
  v_prepare record;
  v_begin record;
  v_reconcile record;
  v_attempt_restore record;
  v_restore_definition text;
  v_reconcile_definition text;
begin
  if to_regclass('public.erp_cloud_restore_attempts') is null
     or v_legacy_oid is null or v_old_effective_oid is null or v_prepare_oid is null
     or v_begin_oid is null or v_reconcile_oid is null or v_attempt_restore_oid is null then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ATTEMPT_POSTFLIGHT_MISSING';
  end if;
  select proowner into v_legacy_owner from pg_catalog.pg_proc where oid = v_legacy_oid;
  select * into v_prepare from pg_catalog.pg_proc where oid = v_prepare_oid;
  select * into v_begin from pg_catalog.pg_proc where oid = v_begin_oid;
  select * into v_reconcile from pg_catalog.pg_proc where oid = v_reconcile_oid;
  select * into v_attempt_restore from pg_catalog.pg_proc where oid = v_attempt_restore_oid;
  if v_prepare.proowner <> v_legacy_owner or v_begin.proowner <> v_legacy_owner
     or v_reconcile.proowner <> v_legacy_owner or v_attempt_restore.proowner <> v_legacy_owner
     or not v_prepare.prosecdef or not v_begin.prosecdef or not v_reconcile.prosecdef or not v_attempt_restore.prosecdef
     or not coalesce(v_prepare.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=10s']::text[]
     or not coalesce(v_begin.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=10s']::text[]
     or not coalesce(v_reconcile.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=10s']::text[]
     or not coalesce(v_attempt_restore.proconfig, '{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[] then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ATTEMPT_FUNCTION_POSTFLIGHT_MISMATCH';
  end if;
  if v_prepare.prokind <> 'f' or v_prepare.provolatile <> 'v' or v_prepare.prorettype <> 'jsonb'::regtype::oid
     or v_prepare.pronargs <> 8
     or v_prepare.proargtypes[0] <> 'uuid'::regtype::oid or v_prepare.proargtypes[1] <> 'uuid'::regtype::oid
     or v_prepare.proargtypes[2] <> 'text'::regtype::oid or v_prepare.proargtypes[3] <> 'text'::regtype::oid
     or v_prepare.proargtypes[4] <> 'text'::regtype::oid or v_prepare.proargtypes[5] <> 'text'::regtype::oid
     or v_prepare.proargtypes[6] <> 'integer'::regtype::oid or v_prepare.proargtypes[7] <> 'text'::regtype::oid
     or v_prepare.proargnames is distinct from array[
       'p_attempt_id','p_trace_id','p_source_fingerprint','p_effective_fingerprint',
       'p_restore_policy','p_target_environment','p_timeout_budget_ms','p_timeout_contract_version'
     ]::text[]
     or v_begin.prokind <> 'f' or v_begin.provolatile <> 'v' or v_begin.prorettype <> 'jsonb'::regtype::oid
     or v_begin.pronargs <> 2
     or v_begin.proargtypes[0] <> 'uuid'::regtype::oid or v_begin.proargtypes[1] <> 'uuid'::regtype::oid
     or v_begin.proargnames is distinct from array['p_attempt_id','p_trace_id']::text[]
     or v_reconcile.prokind <> 'f' or v_reconcile.provolatile <> 'v' or v_reconcile.prorettype <> 'jsonb'::regtype::oid
     or v_reconcile.pronargs <> 2
     or v_reconcile.proargtypes[0] <> 'uuid'::regtype::oid or v_reconcile.proargtypes[1] <> 'uuid'::regtype::oid
     or v_reconcile.proargnames is distinct from array['p_attempt_id','p_trace_id']::text[]
     or v_attempt_restore.prokind <> 'f' or v_attempt_restore.provolatile <> 'v'
     or v_attempt_restore.prorettype <> 'jsonb'::regtype::oid or v_attempt_restore.pronargs <> 8
     or v_attempt_restore.proargtypes[0] <> 'uuid'::regtype::oid
     or v_attempt_restore.proargtypes[1] <> 'uuid'::regtype::oid
     or v_attempt_restore.proargtypes[2] <> 'uuid'::regtype::oid
     or v_attempt_restore.proargtypes[3] <> 'text'::regtype::oid
     or v_attempt_restore.proargtypes[4] <> 'jsonb'::regtype::oid
     or v_attempt_restore.proargtypes[5] <> 'jsonb'::regtype::oid
     or v_attempt_restore.proargtypes[6] <> 'text'::regtype::oid
     or v_attempt_restore.proargtypes[7] <> 'text'::regtype::oid
     or v_attempt_restore.proargnames is distinct from array[
       'p_attempt_id','p_trace_id','p_execution_id','p_snapshot_fingerprint',
       'p_source_snapshot','p_manifest','p_source_environment','p_restore_mode'
     ]::text[] then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ATTEMPT_SIGNATURE_POSTFLIGHT_MISMATCH';
  end if;
  if has_function_privilege('public', v_prepare_oid, 'EXECUTE') or has_function_privilege('anon', v_prepare_oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_prepare_oid, 'EXECUTE')
     or has_function_privilege('public', v_begin_oid, 'EXECUTE') or has_function_privilege('anon', v_begin_oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_begin_oid, 'EXECUTE')
     or has_function_privilege('public', v_reconcile_oid, 'EXECUTE') or has_function_privilege('anon', v_reconcile_oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_reconcile_oid, 'EXECUTE')
     or has_function_privilege('public', v_attempt_restore_oid, 'EXECUTE') or has_function_privilege('anon', v_attempt_restore_oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_attempt_restore_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_old_effective_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_legacy_oid, 'EXECUTE') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ATTEMPT_ACL_POSTFLIGHT_MISMATCH';
  end if;
  if not (select relrowsecurity from pg_catalog.pg_class where oid = 'public.erp_cloud_restore_attempts'::regclass)
     or (select relowner from pg_catalog.pg_class where oid = 'public.erp_cloud_restore_attempts'::regclass) <> v_legacy_owner
     or (select count(*) from pg_catalog.pg_policy where polrelid = 'public.erp_cloud_restore_attempts'::regclass) <> 1
     or (select count(*) from pg_catalog.pg_index where indrelid = 'public.erp_cloud_restore_attempts'::regclass and indisunique and indpred is not null) <> 2
     or has_table_privilege('public', 'public.erp_cloud_restore_attempts', 'SELECT')
     or has_table_privilege('anon', 'public.erp_cloud_restore_attempts', 'SELECT')
     or not has_table_privilege('authenticated', 'public.erp_cloud_restore_attempts', 'SELECT') then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ATTEMPT_TABLE_POSTFLIGHT_MISMATCH';
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='erp_prepare_cloud_restore_attempt') <> 1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='erp_begin_cloud_restore_attempt') <> 1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='erp_reconcile_cloud_restore_attempt') <> 1
     or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='erp_restore_cloud_snapshot_attempt') <> 1 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ATTEMPT_OVERLOAD_COLLISION';
  end if;
  v_restore_definition := regexp_replace(lower(pg_get_functiondef(v_attempt_restore_oid)), '[[:space:]]+', '', 'g');
  v_reconcile_definition := regexp_replace(lower(pg_get_functiondef(v_reconcile_oid)), '[[:space:]]+', '', 'g');
  if regexp_count(v_restore_definition, 'v_result:=public\.erp_restore_cloud_snapshot\(') <> 1
     or strpos(v_restore_definition, 'setstatus=''completed''') = 0
     or strpos(v_restore_definition, 'result_epoch=(v_result->>''restoreepoch'')::bigint') = 0
     or strpos(v_restore_definition, 'canonical_result=v_result') = 0
     or strpos(v_restore_definition, 'v_result:=public.erp_restore_cloud_snapshot(')
        >= strpos(v_restore_definition, 'setstatus=''completed''')
     or strpos(v_reconcile_definition, 'timeout-grace-active') = 0
     or strpos(v_reconcile_definition, 'active-execution-lock') = 0
     or strpos(v_reconcile_definition, 'epoch-or-fingerprint-ambiguous') = 0
     or strpos(v_reconcile_definition, 'setstatus=''not_committed''') = 0 then
    raise exception using errcode = '55000', message = 'CLOUD_RESTORE_ATTEMPT_DEFINITION_POSTFLIGHT_MISMATCH';
  end if;
end;
$restore_attempt_postflight$;

commit;
