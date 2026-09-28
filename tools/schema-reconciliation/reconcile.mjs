import { fingerprintStructuralSnapshot, fingerprintValue, normalizeDefinition } from './schemaContract.mjs';

export const EFFECT_STATES = Object.freeze({
  SATISFIED: 'SATISFIED', NEEDS_APPLY: 'NEEDS_APPLY', PARTIAL: 'PARTIAL',
  CONFLICT: 'CONFLICT', UNKNOWN: 'UNKNOWN',
});

const getTable = (snapshot, name) => snapshot.tables?.[name];
const canonicalFunctionSignature = value => String(value).replace(/\s+/g, '').toLowerCase();
const getFunction = (snapshot, name) => {
  const direct = snapshot.functions?.[name];
  if (direct) return direct;
  const expected = canonicalFunctionSignature(name);
  return Object.entries(snapshot.functions ?? {})
    .find(([signature]) => canonicalFunctionSignature(signature) === expected)?.[1];
};
const canonicalConfig = value => String(value).replace(/\s+/g, '').toLowerCase();
const sameSet = (left = [], right = []) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

function evidenceFor(snapshot, condition) {
  const [schema, tableName, detail] = condition.object.split('.');
  const table = getTable(snapshot, `${schema}.${tableName}`);
  const exact = (present, matches, actual) => ({ present, matches, actual });
  switch (condition.kind) {
    case 'table':
      return exact(Boolean(table), Boolean(table)
        && (condition.rls === undefined || table.rls === condition.rls)
        && (condition.forceRls === undefined || table.forceRls === condition.forceRls), table ?? null);
    case 'tableOwner':
      return exact(Boolean(table), Boolean(table) && table.owner === condition.expected, table?.owner ?? null);
    case 'column': {
      const value = table?.columns?.[detail];
      return exact(Boolean(value), Boolean(value) && value.dataType === condition.expected
        && (condition.nullable === undefined || value.nullable === condition.nullable)
        && (condition.default === undefined || value.default === condition.default), value ?? null);
    }
    case 'columnCompatible': {
      const value = table?.columns?.[detail];
      const matches = !value || (value.dataType === condition.expected
        && (condition.nullable === undefined || value.nullable === condition.nullable)
        && (condition.default === undefined || value.default === condition.default));
      return exact(Boolean(table), Boolean(table) && matches, value ?? null);
    }
    case 'primaryKey':
      return exact(Boolean(table?.primaryKey), sameSet(table?.primaryKey, condition.expected), table?.primaryKey ?? null);
    case 'unique': {
      const uniques = table?.uniques ?? [];
      return exact(Boolean(table), uniques.some(value => sameSet(value, condition.expected)), uniques);
    }
    case 'foreignKey': {
      const constraints = table?.constraints ?? [];
      const canonicalTable = value => String(value).includes('.') ? String(value) : `public.${value}`;
      const matches = constraints.some(value => value.type === 'f'
        && sameSet(value.columns, condition.columns)
        && canonicalTable(value.referencedTable) === canonicalTable(condition.referencedTable)
        && sameSet(value.referencedColumns, condition.referencedColumns)
        && (!condition.onDelete || normalizeDefinition(value.definition)
          .includes(`on delete ${condition.onDelete.toLowerCase()}`)));
      return exact(Boolean(table), matches, constraints.filter(value => value.type === 'f'));
    }
    case 'index': {
      const owner = Object.values(snapshot.tables ?? {}).find(value => value.indexes?.[condition.object]);
      const value = owner?.indexes?.[condition.object];
      const definition = normalizeDefinition(value?.definition ?? '');
      const matches = Boolean(value)
        && (condition.unique === undefined || value.unique === condition.unique)
        && (condition.primary === undefined || value.primary === condition.primary)
        && (condition.valid === undefined || value.valid === condition.valid)
        && (condition.definitionIncludes ?? []).every(entry => definition.includes(normalizeDefinition(entry)));
      return exact(Boolean(value), matches, value ?? null);
    }
    case 'indexCompatible': {
      const owner = Object.values(snapshot.tables ?? {}).find(value => value.indexes?.[condition.object]);
      const value = owner?.indexes?.[condition.object];
      if (!value) return exact(true, true, null);
      const definition = normalizeDefinition(value.definition ?? '');
      const matches = (condition.unique === undefined || value.unique === condition.unique)
        && (condition.primary === undefined || value.primary === condition.primary)
        && (condition.valid === undefined || value.valid === condition.valid)
        && (condition.definitionIncludes ?? []).every(entry => definition.includes(normalizeDefinition(entry)));
      return exact(true, matches, value);
    }
    case 'trigger': {
      const value = table?.triggers?.[detail];
      return exact(Boolean(value), Boolean(value), value ?? null);
    }
    case 'policy': {
      const value = table?.policies?.[detail];
      return exact(Boolean(value), Boolean(value), value ?? null);
    }
    case 'tableGrant':
    case 'tableGrantContains': {
      const grants = table?.grants?.[detail] ?? [];
      const matches = condition.kind === 'tableGrant' || condition.exact
        ? sameSet(grants, condition.expected)
        : condition.expected.every(value => grants.includes(value));
      return exact(Boolean(table), matches, grants);
    }
    case 'tableGrantSubset': {
      const grants = table?.grants?.[detail] ?? [];
      return exact(Boolean(table), Boolean(table) && grants.every(value => condition.expected.includes(value)), grants);
    }
    case 'function': {
      const value = getFunction(snapshot, condition.object);
      const definition = normalizeDefinition(value?.definition ?? '');
      const matches = Boolean(value)
        && (condition.owner === undefined || value.owner === condition.owner)
        && (condition.returnType === undefined || value.returnType === condition.returnType)
        && (condition.securityDefiner === undefined || value.securityDefiner === condition.securityDefiner)
        && (condition.authenticatedExecute === undefined || value.authenticatedExecute === condition.authenticatedExecute)
        && (condition.anonExecute === undefined || value.anonExecute === condition.anonExecute)
        && (condition.publicExecute === undefined || value.publicExecute === condition.publicExecute)
        && (condition.requiredConfig ?? []).every(entry => (value.config ?? [])
          .some(actual => canonicalConfig(actual) === canonicalConfig(entry)))
        && (condition.definitionIncludes ?? []).every(entry => definition.includes(normalizeDefinition(entry)));
      return exact(Boolean(value), matches, value ?? null);
    }
    case 'functionSignatureSet': {
      const prefix = `${condition.object.toLowerCase()}(`;
      const signatures = Object.keys(snapshot.functions ?? {}).filter(signature => signature.toLowerCase().startsWith(prefix));
      return exact(true, sameSet(signatures.map(canonicalFunctionSignature), condition.expected.map(canonicalFunctionSignature)), signatures);
    }
    case 'functionDefinitionCompatible': {
      const value = getFunction(snapshot, condition.object);
      const definition = normalizeDefinition(value?.definition ?? '');
      const matches = Boolean(value) && (condition.variants ?? [])
        .filter(entry => definition.includes(normalizeDefinition(entry))).length === 1;
      return exact(Boolean(value), matches, value ?? null);
    }
    case 'inventoryIntegrity': {
      const value = snapshot.integrity?.inventoryItems;
      return exact(Boolean(value), value?.result === condition.expected, value ?? null);
    }
    default: return exact(false, false, null);
  }
}

const requiredSection = kind => ({
  table: 'tables', tableOwner: 'tables', column: 'columns', columnCompatible: 'columns',
  primaryKey: 'constraints', unique: 'constraints', foreignKey: 'constraints', index: 'indexes', indexCompatible: 'indexes',
  trigger: 'triggers', policy: 'policies', tableGrant: 'grants', tableGrantContains: 'grants',
  tableGrantSubset: 'grants', function: 'functions', functionSignatureSet: 'functions',
  functionDefinitionCompatible: 'functions', inventoryIntegrity: 'inventoryIntegrity',
}[kind]);

export function evaluateConditions(snapshot, conditions) {
  const results = conditions.map(condition => {
    const section = requiredSection(condition.kind);
    if (!snapshot.completeness?.[section]) return { condition, result: 'UNKNOWN', actual: null };
    const evidence = evidenceFor(snapshot, condition);
    return { condition, result: evidence.matches ? 'MATCH'
      : evidence.present && !condition.mismatchIsMissing ? 'CONFLICT' : 'MISSING', actual: evidence.actual };
  });
  return results;
}

export function detectInventoryBridgeState(snapshot) {
  if (!snapshot.completeness?.tables || !snapshot.completeness?.columns
    || !snapshot.completeness?.constraints || !snapshot.completeness?.inventoryIntegrity) {
    return { state: 'UNKNOWN', safeToApply: false, reason: 'inventory identity evidence is incomplete' };
  }
  const table = snapshot.tables?.['public.inventory_items'];
  if (!table) return { state: 'STATE_D', safeToApply: false, reason: 'inventory_items is missing' };
  const pk = table.primaryKey ?? [];
  const id = table.columns?.id;
  const key = table.columns?.inventory_key;
  const uniqueKey = (table.uniques ?? []).some(value => sameSet(value, ['inventory_key']));
  const integrity = snapshot.integrity?.inventoryItems;
  if (sameSet(pk, ['inventory_key']) && !id && key?.dataType === 'text' && key.nullable === false) {
    const safe = integrity?.result === 'PASS' && integrity?.nullInventoryKeyCount === 0
      && integrity?.duplicateInventoryKeyCount === 0 && integrity?.dependentReferenceViolationCount === 0;
    return { state: 'STATE_A', safeToApply: safe, reason: safe ? 'legacy identity and data preconditions pass' : 'legacy shape found but data preconditions failed' };
  }
  if (sameSet(pk, ['id']) && id?.dataType === 'uuid' && id.nullable === false
    && key?.dataType === 'text' && key.nullable === false && uniqueKey) {
    const safe = integrity?.result === 'PASS' && integrity?.nullIdCount === 0
      && integrity?.invalidUuidCount === 0 && integrity?.duplicateIdCount === 0
      && integrity?.duplicateInventoryKeyCount === 0 && integrity?.dependentReferenceViolationCount === 0;
    return { state: safe ? 'STATE_C' : 'STATE_D', safeToApply: false,
      reason: safe ? 'canonical UUID identity already satisfied' : 'canonical shape has failing data integrity' };
  }
  if ((id && sameSet(pk, ['inventory_key'])) || (sameSet(pk, ['id']) && (!uniqueKey || id?.dataType !== 'uuid'))) {
    return { state: 'STATE_B', safeToApply: false, reason: 'partially applied UUID bridge' };
  }
  return { state: 'STATE_D', safeToApply: false, reason: 'unexpected or conflicting inventory identity' };
}

export function reconcileMigration(snapshot, effect) {
  const post = evaluateConditions(snapshot, effect.postconditions);
  const unknown = post.some(item => item.result === 'UNKNOWN');
  const matched = post.filter(item => item.result === 'MATCH').length;
  const missing = post.filter(item => item.result === 'MISSING').length;
  const conflicts = post.filter(item => item.result === 'CONFLICT').length;
  let state;
  if (unknown) state = EFFECT_STATES.UNKNOWN;
  else if (matched === post.length) state = EFFECT_STATES.SATISFIED;
  else if (effect.allowPartialApply) state = EFFECT_STATES.NEEDS_APPLY;
  else if (conflicts > 0) state = EFFECT_STATES.CONFLICT;
  else if (matched > 0 && missing > 0) state = EFFECT_STATES.PARTIAL;
  else state = EFFECT_STATES.NEEDS_APPLY;

  const pre = evaluateConditions(snapshot, effect.preconditions);
  let safeToApply = state === EFFECT_STATES.NEEDS_APPLY && pre.every(item => item.result === 'MATCH');
  let detector = null;
  if (effect.detector === 'inventoryUuidBridge') {
    detector = detectInventoryBridgeState(snapshot);
    if (detector.state === 'STATE_C') state = EFFECT_STATES.SATISFIED;
    else if (detector.state === 'STATE_B') state = EFFECT_STATES.PARTIAL;
    else if (detector.state === 'STATE_D') state = EFFECT_STATES.CONFLICT;
    else if (detector.state === 'UNKNOWN') state = EFFECT_STATES.UNKNOWN;
    safeToApply = state === EFFECT_STATES.NEEDS_APPLY && detector.safeToApply;
  }
  return {
    migrationId: effect.migrationId, sourceFile: effect.sourceFile, sourceChecksum: effect.sourceChecksum,
    canonicalOrder: effect.canonicalOrder,
    state, historicalExecution: snapshot.migrationHistory?.entries?.[effect.migrationId]?.eventType === 'MIGRATION_APPLIED'
      && snapshot.migrationHistory.entries[effect.migrationId].result === 'PASS' ? 'PROVEN_APPLIED' : 'UNPROVEN',
    safeToApply, risk: effect.risk, dependencies: effect.dependencies,
    repairClosure: effect.repairClosure ?? null, repairs: effect.repairs ?? [],
    preconditions: pre, postconditions: post, detector,
  };
}

const applyMethodFor = item => {
  if (item.state === EFFECT_STATES.SATISFIED) return 'NO_APPLY';
  if (item.state === EFFECT_STATES.UNKNOWN) return 'COLLECT_READ_ONLY_EVIDENCE';
  if (item.state === EFFECT_STATES.PARTIAL) return 'TARGETED_COMPATIBILITY_MIGRATION_REQUIRED';
  if (item.state === EFFECT_STATES.CONFLICT) return 'MANUAL_SCHEMA_RECONCILIATION_REQUIRED';
  return item.safeToApply ? 'APPLY_SOURCE_MIGRATION_TRANSACTION' : 'PRECONDITION_REPAIR_REQUIRED';
};

const reasonFor = item => {
  const counts = item.postconditions.reduce((result, value) => ({ ...result,
    [value.result]: (result[value.result] ?? 0) + 1,
  }), {});
  return `postconditions MATCH=${counts.MATCH ?? 0} MISSING=${counts.MISSING ?? 0} CONFLICT=${counts.CONFLICT ?? 0} UNKNOWN=${counts.UNKNOWN ?? 0}`;
};

export function planSchemaDelta(snapshot, registry, options = {}) {
  const migrations = Object.values(registry).sort((a, b) => a.canonicalOrder - b.canonicalOrder)
    .map(effect => reconcileMigration(snapshot, effect));
  const byId = new Map(migrations.map(item => [item.migrationId, item]));
  const producedBy = new Map();
  for (const effect of Object.values(registry)) {
    for (const condition of effect.postconditions) {
      const key = `${condition.kind}:${condition.object}`;
      const current = producedBy.get(key) ?? [];
      current.push(effect.migrationId); producedBy.set(key, current);
    }
  }
  for (const item of migrations) {
    if (item.state !== EFFECT_STATES.NEEDS_APPLY) continue;
    const prerequisitesSatisfiable = item.preconditions.every(check => {
      if (check.result === 'MATCH') return true;
      if (check.result !== 'MISSING') return false;
      const producers = producedBy.get(`${check.condition.kind}:${check.condition.object}`) ?? [];
      return producers.some(id => {
        const producer = byId.get(id);
        return producer && producer.migrationId !== item.migrationId
          && producer.canonicalOrder < item.canonicalOrder
          && (producer.state === EFFECT_STATES.SATISFIED
            || (producer.state === EFFECT_STATES.NEEDS_APPLY && producer.safeToApply));
      });
    });
    item.safeToApply = prerequisitesSatisfiable;
    if (!item.safeToApply) continue;
    const blockedDependency = item.dependencies.find(id => {
      const dependency = byId.get(id);
      return dependency && dependency.state !== EFFECT_STATES.SATISFIED
        && !(dependency.state === EFFECT_STATES.NEEDS_APPLY && dependency.safeToApply);
    });
    if (blockedDependency) {
      item.safeToApply = false;
      item.dependencyBlocker = blockedDependency;
    }
  }
  for (const item of migrations) {
    if (!item.repairClosure || item.state === EFFECT_STATES.SATISFIED) continue;
    const repair = byId.get(item.repairClosure);
    if (repair && (repair.state === EFFECT_STATES.SATISFIED
      || (repair.state === EFFECT_STATES.NEEDS_APPLY && repair.safeToApply))) {
      item.coveredByRepair = repair.migrationId;
    }
  }
  const blockers = migrations.filter(item => !item.coveredByRepair
    && ([EFFECT_STATES.PARTIAL, EFFECT_STATES.CONFLICT, EFFECT_STATES.UNKNOWN].includes(item.state)
      || (item.state === EFFECT_STATES.NEEDS_APPLY && !item.safeToApply)));
  const readyForApply = blockers.length === 0;
  const currentFingerprint = snapshot.completeness?.structural === true
    ? fingerprintStructuralSnapshot(snapshot) : null;
  for (const item of migrations) {
    item.reason = reasonFor(item);
    item.applyMethod = applyMethodFor(item);
    if (item.coveredByRepair) item.applyMethod = 'SUPERSEDED_BY_COMPATIBILITY_REPAIR';
    item.postflightChecks = item.postconditions.map(check => check.condition.object);
  }
  const applyPlan = migrations.filter(item => item.state === EFFECT_STATES.NEEDS_APPLY
    && item.safeToApply && !item.coveredByRepair).map(item => ({
    migrationId: item.migrationId, sourceFile: item.sourceFile, sourceChecksum: item.sourceChecksum,
    canonicalOrder: item.canonicalOrder, applyMethod: item.applyMethod,
  }));
  const baselineRecord = (snapshot.migrationHistory?.records ?? []).find(record => record.eventType === 'BASELINE_ADOPTED'
    && record.eventKey === options.requiredBaselineId && record.result === 'PASS') ?? null;
  return {
    contractVersion: 1,
    mode: options.mode ?? 'PRE_ADOPTION',
    requiredBaselineId: options.requiredBaselineId ?? null,
    environment: options.environment ?? snapshot.identity?.environmentRole ?? 'UNKNOWN',
    projectRef: snapshot.identity?.projectRef ?? null,
    sourceHead: options.sourceHead ?? null,
    checkpoint: options.checkpoint ?? null,
    migrationHistoryProvenance: snapshot.migrationHistory?.available ? 'AVAILABLE' : 'UNAVAILABLE',
    currentFingerprint,
    expectedFingerprint: options.expectedSnapshot ? fingerprintStructuralSnapshot(options.expectedSnapshot) : null,
    targetAfterDeltaFingerprint: options.expectedSnapshot ? fingerprintStructuralSnapshot(options.expectedSnapshot) : null,
    migrations,
    baselineRecord,
    blockers: blockers.map(item => ({ migrationId: item.migrationId, state: item.state })),
    applyPlan,
    readyForApply,
    evidenceFingerprint: fingerprintValue({ snapshot, migrations: migrations.map(({ postconditions, preconditions, ...item }) => item) }),
  };
}

export function formatReconciliationReport(plan) {
  const labels = { SATISFIED: '已符合', NEEDS_APPLY: '需要新增／更新', PARTIAL: '部分存在，需相容修復', CONFLICT: '結構衝突', UNKNOWN: '證據不足' };
  const lines = [
    'LIVE SCHEMA RECONCILIATION REPORT',
    `Migration history: ${plan.migrationHistoryProvenance}`,
    `Current fingerprint: ${plan.currentFingerprint ?? 'UNKNOWN'}`,
    '',
  ];
  for (const item of plan.migrations) {
    lines.push(`${item.migrationId} ${item.sourceFile}`);
    lines.push(`判定：${labels[item.state]}`);
    lines.push(`歷史執行證據：${item.historicalExecution}`);
    lines.push(`Apply safety：${item.safeToApply ? 'PASS' : item.state === 'SATISFIED' ? 'NO APPLY' : 'BLOCK'}`);
    lines.push(`原因：${item.reason}`);
    lines.push(`資料風險：${item.risk}`);
    lines.push(`方式：${item.applyMethod}`);
    if (item.coveredByRepair) lines.push(`相容修復：${item.coveredByRepair} 已納入安全 apply plan`);
    lines.push(`依賴：${item.dependencies.join(', ') || '無'}`);
    const checks = [...new Set(item.postflightChecks)];
    lines.push(`Postflight：${checks.length} 項（${checks.slice(0, 8).join(', ')}${checks.length > 8 ? ', …' : ''}）`);
    lines.push('');
  }
  lines.push('LIVE MIGRATION DELTA');
  for (const planned of plan.applyPlan) {
    const item = plan.migrations.find(value => value.migrationId === planned.migrationId);
    lines.push(`${item.migrationId} | ${item.state} | ${item.applyMethod} | ${item.risk}`);
  }
  lines.push(`READY FOR APPLY = ${plan.readyForApply ? 'YES' : 'NO'}`);
  return lines.join('\n');
}
