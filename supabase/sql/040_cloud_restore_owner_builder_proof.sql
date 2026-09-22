-- 040: authenticated OWNER-only, non-destructive Restore candidate proof.
-- Candidate artifact only. Apply only in a separately authorized Staging gate.
-- 031-039 are immutable history; this migration adds observation only.
begin;

do $proof_preflight$
declare
  v_builder_oid oid := to_regprocedure('public.erp_cloud_restore_build_effective_snapshot(jsonb,jsonb,text)');
  v_validator_oid oid := to_regprocedure('public.erp_cloud_restore_validate_portability(jsonb,jsonb,text)');
  v_audit_oid oid := to_regprocedure('public.erp_cloud_restore_audit_dataset(jsonb)');
  v_legacy_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)');
  v_effective_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot_effective(uuid,text,jsonb,jsonb,text,text)');
  v_attempt_oid oid := to_regprocedure('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)');
  v_builder record;
  v_validator record;
  v_audit record;
  v_builder_definition text;
  v_validator_definition text;
  v_audit_definition text;
begin
  if current_user <> 'postgres'
     or to_regprocedure('public.is_owner(uuid)') is null
     or to_regrole('authenticated') is null
     or to_regrole('anon') is null
     or v_builder_oid is null
     or v_validator_oid is null
     or v_audit_oid is null
     or v_legacy_oid is null
     or v_effective_oid is null
     or v_attempt_oid is null then
    raise exception using errcode='55000', message='CLOUD_RESTORE_PROOF_BASE_CONTRACT_MISSING';
  end if;
  if to_regprocedure('public.erp_cloud_restore_canonical_json_text(jsonb)') is not null
     or to_regprocedure('public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)') is not null
     or exists (
       select 1 from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='erp_prove_cloud_restore_candidate'
     ) then
    raise exception using errcode='42710', message='CLOUD_RESTORE_PROOF_COLLISION';
  end if;

  select * into v_builder from pg_catalog.pg_proc where oid=v_builder_oid;
  select * into v_validator from pg_catalog.pg_proc where oid=v_validator_oid;
  select * into v_audit from pg_catalog.pg_proc where oid=v_audit_oid;
  if v_builder.proowner <> 'postgres'::regrole
     or v_validator.proowner <> v_builder.proowner
     or v_audit.proowner <> v_builder.proowner
     or not v_builder.prosecdef
     or not v_validator.prosecdef
     or v_audit.prosecdef
     or v_builder.provolatile <> 'v'
     or v_validator.provolatile <> 'v'
     or v_audit.provolatile <> 'i'
     or not coalesce(v_builder.proconfig,'{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]
     or not coalesce(v_validator.proconfig,'{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]
     or not coalesce(v_audit.proconfig,'{}'::text[]) @> array['search_path=pg_catalog, public, extensions']::text[] then
    raise exception using errcode='55000', message='CLOUD_RESTORE_PROOF_BASE_SECURITY_MISMATCH';
  end if;
  if has_function_privilege('public',v_builder_oid,'EXECUTE')
     or has_function_privilege('anon',v_builder_oid,'EXECUTE')
     or has_function_privilege('authenticated',v_builder_oid,'EXECUTE')
     or has_function_privilege('public',v_audit_oid,'EXECUTE')
     or has_function_privilege('anon',v_audit_oid,'EXECUTE')
     or has_function_privilege('authenticated',v_audit_oid,'EXECUTE')
     or has_function_privilege('authenticated',v_legacy_oid,'EXECUTE')
     or has_function_privilege('authenticated',v_effective_oid,'EXECUTE')
     or not has_function_privilege('authenticated',v_attempt_oid,'EXECUTE') then
    raise exception using errcode='55000', message='CLOUD_RESTORE_PROOF_BASE_ACL_MISMATCH';
  end if;

  v_builder_definition := regexp_replace(lower(pg_get_functiondef(v_builder_oid)),'[[:space:]]+','','g');
  v_validator_definition := regexp_replace(lower(pg_get_functiondef(v_validator_oid)),'[[:space:]]+','','g');
  v_audit_definition := regexp_replace(lower(pg_get_functiondef(v_audit_oid)),'[[:space:]]+','','g');
  if regexp_count(v_builder_definition,'jsonb_array_elements\(p_source_snapshot->v_table\)') <> 1
     or regexp_count(v_builder_definition,'erp_cloud_restore_reject_invalid_portable_row') <> 1
     or strpos(v_builder_definition,'jsonb_build_object(''updated_by'',null)') = 0
     or strpos(v_builder_definition,'cross-environment-audit-null-v1') = 0
     or v_builder_definition ~ '(insertinto|updatepublic\.|deletefrom|truncate|pg_advisory|erp_restore_cloud_snapshot)'
     or strpos(v_validator_definition,'public.is_owner(v_actor)') = 0
     or strpos(v_validator_definition,'current_setting(''request.headers'',true)') = 0
     or strpos(v_validator_definition,'cloud_restore_portability_target_mismatch') = 0
     or v_validator_definition ~ '(insertinto|updatepublic\.|deletefrom|truncate|pg_advisory|erp_restore_cloud_snapshot)'
     or strpos(v_audit_definition,'''relationship_hash''') = 0
     or strpos(v_audit_definition,'''total_rows''') = 0
     or v_audit_definition ~ '(insertinto|updatepublic\.|deletefrom|truncate|pg_advisory|erp_restore_cloud_snapshot)'
  then
    raise exception using errcode='55000', message='CLOUD_RESTORE_PROOF_READ_ONLY_BASE_MISMATCH';
  end if;
end;
$proof_preflight$;

-- Private pure serializer matching cloudAtomicRestore.stableCloudRestoreJson:
-- recursively key-sorted objects, array order preserved and compact JSON.
create function public.erp_cloud_restore_canonical_json_text(p_value jsonb)
returns text
language sql
immutable
strict
parallel safe
security invoker
set search_path = pg_catalog
as $canonical$
  select case jsonb_typeof(p_value)
    when 'object' then '{'||coalesce((
      select string_agg(to_json(e.key)::text||':'||public.erp_cloud_restore_canonical_json_text(e.value),',' order by e.key collate "C")
      from jsonb_each(p_value) e
    ),'')||'}'
    when 'array' then '['||coalesce((
      select string_agg(public.erp_cloud_restore_canonical_json_text(a.value),',' order by a.ordinality)
      from jsonb_array_elements(p_value) with ordinality a(value,ordinality)
    ),'')||']'
    else p_value::text
  end
$canonical$;
revoke all on function public.erp_cloud_restore_canonical_json_text(jsonb) from public,anon,authenticated;

create function public.erp_prove_cloud_restore_candidate(
  p_source_snapshot jsonb,
  p_manifest jsonb,
  p_restore_mode text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, extensions
set statement_timeout = '120s'
as $proof$
declare
  v_actor uuid := auth.uid();
  v_started_at timestamptz := clock_timestamp();
  v_request_headers jsonb;
  v_request_host text;
  v_policy text;
  v_expected_source_fingerprint text;
  v_source_fingerprint text;
  v_effective_fingerprint text;
  v_effective jsonb;
  v_validation jsonb;
  v_audit jsonb;
  v_integrity jsonb;
  v_coverage_count integer;
  v_transformed bigint := 0;
begin
  if v_actor is null then
    raise exception using errcode='42501', message='AUTHENTICATION_REQUIRED';
  end if;
  if public.is_owner(v_actor) is distinct from true then
    raise exception using errcode='42501', message='CLOUD_RESTORE_OWNER_REQUIRED';
  end if;
  begin
    v_request_headers := nullif(current_setting('request.headers',true),'')::jsonb;
  exception when others then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_TARGET_MISMATCH';
  end;
  v_request_host := lower(split_part(coalesce(v_request_headers->>'host',''),':',1));
  if split_part(v_request_host,'.',1) is distinct from 'rhfdjsklfrgpoqsaqpkn' then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_TARGET_MISMATCH';
  end if;
  if jsonb_typeof(p_source_snapshot) is distinct from 'object'
     or jsonb_typeof(p_manifest) is distinct from 'object'
     or p_restore_mode is null
     or p_restore_mode not in ('strict','cross-environment') then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_INPUT_INVALID';
  end if;

  if p_restore_mode='cross-environment' then
    if jsonb_typeof(p_manifest->'portability') is distinct from 'object'
       or p_manifest->'portability'->>'policyVersion' is distinct from 'cross-environment-audit-null-v1'
       or p_manifest->'portability'->>'mode' is distinct from 'cross-environment'
       or p_manifest->'portability'->>'targetProjectRef' is distinct from 'rhfdjsklfrgpoqsaqpkn'
       or jsonb_typeof(p_manifest->'portability'->'totalTransformedRows') is distinct from 'number'
       or coalesce(p_manifest->'portability'->>'totalTransformedRows','') !~ '^[0-9]+$' then
      raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_POLICY_INVALID';
    end if;
    v_policy := p_manifest->'portability'->>'policyVersion';
    v_expected_source_fingerprint := p_manifest->'portability'->>'sourceSnapshotFingerprint';
    v_transformed := (p_manifest->'portability'->>'totalTransformedRows')::bigint;
  else
    if p_manifest ? 'portability' then
      raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_POLICY_INVALID';
    end if;
    v_policy := 'strict';
    v_expected_source_fingerprint := p_manifest->>'snapshotFingerprint';
  end if;
  if coalesce(v_expected_source_fingerprint,'') !~ '^[0-9a-f]{64}$'
     or coalesce(p_manifest->>'snapshotFingerprint','') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_FINGERPRINT_INVALID';
  end if;

  v_source_fingerprint := encode(extensions.digest(convert_to(
    public.erp_cloud_restore_canonical_json_text(p_source_snapshot),'UTF8'
  ),'sha256'),'hex');
  if v_source_fingerprint is distinct from v_expected_source_fingerprint then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_SOURCE_FINGERPRINT_MISMATCH';
  end if;

  v_effective := public.erp_cloud_restore_build_effective_snapshot(
    p_source_snapshot,
    p_manifest,
    p_restore_mode
  );
  if p_restore_mode='cross-environment' then
    v_validation := public.erp_cloud_restore_validate_portability(
      v_effective,
      p_manifest,
      'rhfdjsklfrgpoqsaqpkn'
    );
    if v_validation->>'ok' is distinct from 'true' then
      raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_PORTABILITY_INVALID';
    end if;
  end if;

  -- Closed dataset coverage is checked before fingerprints so unknown resources
  -- cannot be disguised as a generic hash mismatch.
  v_audit := public.erp_cloud_restore_audit_dataset(v_effective);
  v_effective_fingerprint := encode(extensions.digest(convert_to(
    public.erp_cloud_restore_canonical_json_text(v_effective),'UTF8'
  ),'sha256'),'hex');
  if v_effective_fingerprint is distinct from p_manifest->>'snapshotFingerprint' then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_EFFECTIVE_FINGERPRINT_MISMATCH';
  end if;
  v_integrity := v_audit->'integrity';
  select count(*) into v_coverage_count from jsonb_object_keys(v_audit->'table_counts');
  if jsonb_typeof(p_manifest->'resourceCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'totalRows') is distinct from 'number'
     or jsonb_typeof(p_manifest->'orphanCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'duplicateVariantIdCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'duplicateVariantLocalIdCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'duplicateCanonicalIdCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'canonicalIdentityAnomalyCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'unknownProductCount') is distinct from 'number'
     or jsonb_typeof(p_manifest->'optionalMetadataMissingReferenceCount') is distinct from 'number'
     or v_coverage_count <> 15
     or p_manifest->>'resourceCount' is distinct from '15'
     or jsonb_typeof(p_manifest->'counts') is distinct from 'object'
     or p_manifest->'counts' is distinct from v_audit->'table_counts'
     or (p_manifest->>'totalRows')::bigint is distinct from (v_audit->>'total_rows')::bigint
     or p_manifest->>'relationshipHash' is distinct from v_audit->>'relationship_hash'
     or (p_manifest->>'orphanCount')::bigint is distinct from (v_integrity->>'orphan_count')::bigint
     or (p_manifest->>'duplicateVariantIdCount')::bigint is distinct from (v_integrity->>'duplicate_variant_id_count')::bigint
     or (p_manifest->>'duplicateVariantLocalIdCount')::bigint is distinct from (v_integrity->>'duplicate_variant_local_id_count')::bigint
     or (p_manifest->>'duplicateCanonicalIdCount')::bigint is distinct from (v_integrity->>'duplicate_canonical_id_count')::bigint
     or (p_manifest->>'canonicalIdentityAnomalyCount')::bigint is distinct from (v_integrity->>'canonical_identity_anomaly_count')::bigint
     or (p_manifest->>'unknownProductCount')::bigint is distinct from (v_integrity->>'unknown_product_count')::bigint
     or (p_manifest->>'optionalMetadataMissingReferenceCount')::bigint is distinct from (v_integrity->>'optional_metadata_missing_reference_count')::bigint
     or (v_integrity->>'duplicate_inventory_key_count')::bigint <> 0
     or (v_integrity->>'missing_inventory_key_count')::bigint <> 0
     or (p_restore_mode='cross-environment' and (
       (v_audit->'audit_policy'->>'covered_updated_by_non_null_count')::bigint <> 0
       or (v_audit->'audit_policy'->>'covered_updated_by_null_count')::bigint
          is distinct from (v_audit->>'total_rows')::bigint
     )) then
    raise exception using errcode='22023', message='CLOUD_RESTORE_PROOF_CANDIDATE_INVALID';
  end if;

  return jsonb_build_object(
    'ok',true,
    'candidate_valid',true,
    'schema_version','cloud-restore-candidate-proof-v1',
    'policy',v_policy,
    'resource_count',15,
    'coverage_count',v_coverage_count,
    'total_rows',(v_audit->>'total_rows')::bigint,
    'table_counts',v_audit->'table_counts',
    'transformed_updated_by_count',v_transformed,
    'source_fingerprint',v_source_fingerprint,
    'effective_fingerprint',v_effective_fingerprint,
    'relationship_hash',v_audit->>'relationship_hash',
    'integrity',v_integrity,
    'elapsed_ms',(extract(epoch from clock_timestamp()-v_started_at)*1000)::bigint
  );
end;
$proof$;

revoke all on function public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text) to authenticated;

do $proof_postflight$
declare
  v_canonical_oid oid := to_regprocedure('public.erp_cloud_restore_canonical_json_text(jsonb)');
  v_oid oid := to_regprocedure('public.erp_prove_cloud_restore_candidate(jsonb,jsonb,text)');
  v_canonical record;
  v_proc record;
  v_canonical_definition text;
  v_definition text;
begin
  if v_canonical_oid is null or v_oid is null then
    raise exception using errcode='55000', message='CLOUD_RESTORE_PROOF_POSTFLIGHT_MISSING';
  end if;
  select * into v_canonical from pg_catalog.pg_proc where oid=v_canonical_oid;
  select * into v_proc from pg_catalog.pg_proc where oid=v_oid;
  if v_canonical.proowner <> 'postgres'::regrole
     or v_canonical.prokind <> 'f'
     or v_canonical.prorettype <> 'text'::regtype
     or v_canonical.pronargs <> 1
     or v_canonical.proargtypes[0] <> 'jsonb'::regtype
     or v_canonical.proargnames is distinct from array['p_value']::text[]
     or v_canonical.prosecdef
     or v_canonical.provolatile <> 'i'
     or v_canonical.proparallel <> 's'
     or not v_canonical.proisstrict
     or not coalesce(v_canonical.proconfig,'{}'::text[]) @> array['search_path=pg_catalog']::text[]
     or has_function_privilege('public',v_canonical_oid,'EXECUTE')
     or has_function_privilege('anon',v_canonical_oid,'EXECUTE')
     or has_function_privilege('authenticated',v_canonical_oid,'EXECUTE')
     or v_proc.proowner <> 'postgres'::regrole
     or v_proc.prokind <> 'f'
     or v_proc.prorettype <> 'jsonb'::regtype
     or v_proc.pronargs <> 3
     or v_proc.proargtypes[0] <> 'jsonb'::regtype
     or v_proc.proargtypes[1] <> 'jsonb'::regtype
     or v_proc.proargtypes[2] <> 'text'::regtype
     or v_proc.proargnames is distinct from array['p_source_snapshot','p_manifest','p_restore_mode']::text[]
     or not v_proc.prosecdef
     or v_proc.provolatile <> 'v'
     or not coalesce(v_proc.proconfig,'{}'::text[]) @> array['search_path=pg_catalog, public, extensions','statement_timeout=120s']::text[]
     or has_function_privilege('public',v_oid,'EXECUTE')
     or has_function_privilege('anon',v_oid,'EXECUTE')
     or not has_function_privilege('authenticated',v_oid,'EXECUTE')
     or exists (
       select 1 from pg_catalog.aclexplode(coalesce(v_proc.proacl,pg_catalog.acldefault('f',v_proc.proowner))) a
       where a.privilege_type='EXECUTE'
         and (a.grantee=0 or (a.grantee<>v_proc.proowner and a.grantee<>'authenticated'::regrole) or a.is_grantable)
     )
     or (select count(*) from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='erp_cloud_restore_canonical_json_text') <> 1
     or (select count(*) from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='erp_prove_cloud_restore_candidate') <> 1 then
    raise exception using errcode='55000', message='CLOUD_RESTORE_PROOF_POSTFLIGHT_CONTRACT_MISMATCH';
  end if;

  v_canonical_definition := regexp_replace(lower(pg_get_functiondef(v_canonical_oid)),'[[:space:]]+','','g');
  v_definition := regexp_replace(lower(pg_get_functiondef(v_oid)),'[[:space:]]+','','g');
  -- pg_get_functiondef includes the CREATE signature plus both recursive calls.
  if regexp_count(v_canonical_definition,'public\.erp_cloud_restore_canonical_json_text\(') <> 3
     or v_canonical_definition ~ '(insertinto|updatepublic\.|deletefrom|truncate|pg_advisory|erp_restore_cloud_snapshot)'
     or regexp_count(v_definition,'public\.erp_cloud_restore_build_effective_snapshot\(') <> 1
     or regexp_count(v_definition,'public\.erp_cloud_restore_validate_portability\(') <> 1
     or regexp_count(v_definition,'public\.erp_cloud_restore_audit_dataset\(') <> 1
     or regexp_count(v_definition,'public\.erp_cloud_restore_canonical_json_text\(') <> 2
     or strpos(v_definition,'public.is_owner(v_actor)') = 0
     or strpos(v_definition,'current_setting(''request.headers'',true)') = 0
     or strpos(v_definition,'''candidate_valid'',true') = 0
     or v_definition ~ '(insertinto|updatepublic\.|deletefrom|truncate|pg_advisory|erp_restore_cloud_snapshot|erp_prepare_cloud_restore|erp_begin_cloud_restore|erp_reconcile_cloud_restore)'
  then
    raise exception using errcode='55000', message='CLOUD_RESTORE_PROOF_POSTFLIGHT_DEFINITION_MISMATCH';
  end if;
end;
$proof_postflight$;

commit;
