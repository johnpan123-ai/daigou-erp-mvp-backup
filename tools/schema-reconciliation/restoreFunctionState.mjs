export const RESTORE_FUNCTION_STATES = Object.freeze({
  PRE_045: 'STATE_A_PRE_045',
  ORIGINAL_045_PARTIAL: 'STATE_B_045_PARTIAL',
  REPAIR_045B_COMPATIBLE: 'STATE_C_045B_COMPATIBLE',
  CANONICAL: 'STATE_D_CANONICAL',
  CONFLICT: 'STATE_E_UNKNOWN_CONFLICT',
});

export const CORE_RESTORE_RESOURCES = Object.freeze([
  'bundle_components', 'inventory_items', 'japan_package_items', 'japan_packages',
  'outbound_shipment_items', 'outbound_shipments', 'private_order_items', 'private_orders',
  'product_categories', 'product_groups', 'product_variants', 'purchase_batch_items',
  'purchase_batches', 'sales_order_items', 'sales_orders',
]);

export const CANONICAL_RESTORE_RESOURCES = Object.freeze([
  'bundle_components', 'dashboard_category_images', 'import_batches', 'inventory_items',
  'japan_package_items', 'japan_packages', 'outbound_shipment_items', 'outbound_shipments',
  'private_order_items', 'private_orders', 'product_categories', 'product_groups', 'product_variants',
  'purchase_batch_items', 'purchase_batches', 'sales_order_items', 'sales_orders',
  'waca_cutover_audit', 'waca_import_batches', 'waca_mappings', 'waca_master_links',
  'waca_order_items', 'waca_orders', 'waca_state',
]);

const sameSet = (left = [], right = []) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const requiredSemanticInvariants = Object.freeze([
  'proofFlow', 'prepareFlow', 'executeFlow', 'failurePersistence', 'reconciliation',
  'rollback', 'requestProofIds', 'signatureContract', 'securityMode', 'searchPath',
  'acl', 'transactionBoundary', 'smallExecuteEnvelope',
]);

export function classifyRestoreFunctionState(facts) {
  const invariantsPass = facts?.controlPlane === true && facts?.surfaceMetadata === true
    && requiredSemanticInvariants.every(key => facts?.invariants?.[key] === true);
  if (!invariantsPass || facts.validator !== facts.recompute) return RESTORE_FUNCTION_STATES.CONFLICT;
  const coreSnapshot = sameSet(facts.snapshotKeys, CORE_RESTORE_RESOURCES);
  const fullSnapshot = sameSet(facts.snapshotKeys, CANONICAL_RESTORE_RESOURCES);
  if (facts.auditCoreAccepted === true && facts.auditFullAccepted === false && coreSnapshot
      && facts.validator === false && facts.recompute === false && facts.importGuard === false) {
    return RESTORE_FUNCTION_STATES.PRE_045;
  }
  if (facts.auditCoreAccepted === false && facts.auditFullAccepted === true
      && facts.validator === true && facts.recompute === true && coreSnapshot) {
    return RESTORE_FUNCTION_STATES.ORIGINAL_045_PARTIAL;
  }
  if (facts.auditCoreAccepted === false && facts.auditFullAccepted === true && fullSnapshot
      && facts.validator === true && facts.recompute === true && facts.importGuard === false) {
    return RESTORE_FUNCTION_STATES.REPAIR_045B_COMPATIBLE;
  }
  if (facts.auditCoreAccepted === false && facts.auditFullAccepted === true && fullSnapshot
      && facts.validator === true && facts.recompute === true && facts.importGuard === true) {
    return RESTORE_FUNCTION_STATES.CANONICAL;
  }
  return RESTORE_FUNCTION_STATES.CONFLICT;
}

export function restoreFactsFromStructuralSnapshot(snapshot) {
  const functions = snapshot?.functions ?? {};
  const functionBySignature = signature => functions[signature]
    ?? Object.entries(functions).find(([key]) => key.replace(/\s+/gu, '').toLowerCase()
      === signature.replace(/\s+/gu, '').toLowerCase())?.[1];
  const definition = signature => String(functionBySignature(signature)?.definition ?? '').toLowerCase();
  const validator = Boolean(functionBySignature('public.erp_cloud_restore_validate_waca_dataset(jsonb)'));
  const recompute = Boolean(functionBySignature('public.erp_cloud_restore_recompute_waca_quantities()'));
  const snapshotDefinition = definition('public.erp_cloud_restore_snapshot()');
  const snapshotKeys = CANONICAL_RESTORE_RESOURCES.filter(key => snapshotDefinition.includes(`'${key}'`));
  const auditDefinition = definition('public.erp_cloud_restore_audit_dataset(jsonb)');
  const control = [
    'public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)',
    'public.erp_reconcile_cloud_restore_attempt(uuid,uuid)',
    'public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)',
    'public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)',
  ].map(functionBySignature);
  const metadataOk = value => value?.owner === 'postgres' && value.securityDefiner === true
    && value.authenticatedExecute === true && value.anonExecute === false && value.publicExecute === false;
  const attempt = definition('public.erp_restore_cloud_snapshot_attempt(uuid,uuid,uuid,text,jsonb,jsonb,text,text)');
  const reconcile = definition('public.erp_reconcile_cloud_restore_attempt(uuid,uuid)');
  const proof = definition('public.erp_prove_cloud_restore_candidate_v2(jsonb,jsonb,text,text,uuid)');
  const execute = definition('public.erp_restore_proven_cloud_snapshot_attempt(uuid,uuid,uuid,uuid,uuid)');
  const importGuard = Boolean(snapshot?.tables?.['public.import_batches']?.triggers?.erp_cloud_restore_maintenance_guard);
  const surfaceMetadata = [
    'public.erp_cloud_restore_snapshot()', 'public.erp_cloud_restore_audit_dataset(jsonb)',
    'public.erp_restore_cloud_snapshot(uuid,text,jsonb,jsonb,text)',
  ].map(functionBySignature).every(value => value?.owner === 'postgres'
    && value.anonExecute === false && value.publicExecute === false);
  return {
    auditCoreAccepted: auditDefinition.includes('<> 15') || auditDefinition.includes('<>15'),
    auditFullAccepted: auditDefinition.includes('<> 24') || auditDefinition.includes('<>24'),
    snapshotKeys, validator, recompute, importGuard,
    controlPlane: control.every(metadataOk), surfaceMetadata,
    invariants: {
      proofFlow: proof.includes('erp_prove_cloud_restore_candidate') && proof.includes('erp_cloud_restore_build_effective_snapshot'),
      prepareFlow: proof.includes('proof_id'), executeFlow: execute.includes('p_proof_id'),
      failurePersistence: attempt.includes('erp_cloud_restore_failures'),
      reconciliation: reconcile.includes('execution_id') && reconcile.includes('not_committed'),
      rollback: attempt.includes('rollback') && attempt.includes('erp_restore_cloud_snapshot'),
      requestProofIds: proof.includes('request_id') && execute.includes('p_proof_id'),
      signatureContract: control.every(Boolean), securityMode: control.every(metadataOk),
      searchPath: control.every(value => (value?.config ?? []).some(entry => entry.startsWith('search_path='))),
      acl: control.every(metadataOk), transactionBoundary: attempt.includes('execution_started_at'),
      smallExecuteEnvelope: !execute.includes('jsonb p_snapshot') && execute.includes('p_proof_id'),
    },
  };
}
