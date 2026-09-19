export const POSTGRES_TYPE_OIDS = Object.freeze({
  text: 25,
  uuid: 2950,
  jsonb: 3802,
});

export const LIVE_STAGING_CATALOG_REFERENCES = Object.freeze({
  fieldMutations: Object.freeze({
    resolved: true,
    schemaName: 'public',
    functionName: 'erp_apply_field_mutations',
    overloadCount: 1,
    argumentCount: 2,
    argumentTypes: '25 3802',
    argumentNames: ['p_entity', 'p_operations'],
    returnType: POSTGRES_TYPE_OIDS.jsonb,
    kind: 'f',
    securityDefiner: true,
    ownerRole: 'postgres',
    currentUser: 'postgres',
    sessionUser: 'postgres',
    config: ['search_path=""'],
    publicExecute: false,
    anonExecute: false,
    authenticatedExecute: true,
  }),
  purchaseBatch: Object.freeze({
    resolved: true,
    schemaName: 'public',
    functionName: 'erp_apply_purchase_batch_transaction',
    overloadCount: 1,
    argumentCount: 2,
    argumentTypes: '2950 3802',
    argumentNames: ['p_idempotency_key', 'p_request'],
    returnType: POSTGRES_TYPE_OIDS.jsonb,
    kind: 'f',
    securityDefiner: true,
    ownerRole: 'postgres',
    currentUser: 'postgres',
    sessionUser: 'postgres',
    config: ['search_path=""'],
    publicExecute: false,
    anonExecute: false,
    authenticatedExecute: true,
  }),
});

function parseOidVector(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.trim().split(/\s+/u).map(Number);
}

function configValues(config, key) {
  if (!Array.isArray(config)) return [];
  return config
    .filter((entry) => typeof entry === 'string' && entry.startsWith(`${key}=`))
    .map((entry) => entry.slice(key.length + 1))
    .sort();
}

export function retargetLiveCatalog(reference, expected) {
  return {
    ...reference,
    schemaName: expected.schemaName,
    functionName: expected.functionName,
    argumentCount: expected.argumentTypes.length,
    argumentTypes: expected.argumentTypes.join(' '),
    argumentNames: [...expected.argumentNames],
    returnType: expected.returnType,
    config: Object.entries(expected.configValues)
      .map(([key, value]) => `${key}=${value}`)
      .sort(),
  };
}

export function diagnosePostgresFunctionContract(row, expected, codes) {
  if (row.resolved !== true) return codes.signatureMissing;
  if (row.schemaName !== expected.schemaName || row.functionName !== expected.functionName) {
    return codes.signature;
  }
  if (row.overloadCount !== 1) return codes.overload;
  if (row.argumentCount !== expected.argumentTypes.length) return codes.argumentCount;

  const argumentTypes = parseOidVector(row.argumentTypes);
  if (argumentTypes.length !== expected.argumentTypes.length
      || argumentTypes.some((value, index) => value !== expected.argumentTypes[index])) {
    return codes.argumentTypes;
  }
  if (!Array.isArray(row.argumentNames)
      || row.argumentNames.length !== expected.argumentNames.length
      || row.argumentNames.some((value, index) => value !== expected.argumentNames[index])) {
    return codes.argumentNames;
  }
  if (row.returnType !== expected.returnType) return codes.returnType;
  if (row.kind !== 'f') return codes.kind;
  if (row.ownerRole !== row.currentUser) return codes.owner;
  if (row.securityDefiner !== true) return codes.securityDefiner;

  for (const [key, expectedValue] of Object.entries(expected.configValues)) {
    if (configValues(row.config, key).length !== 1
        || configValues(row.config, key)[0] !== expectedValue) {
      return codes.config[key];
    }
  }
  if (row.publicExecute !== false) return codes.publicAcl;
  if (row.anonExecute !== false) return codes.anonAcl;
  if (row.authenticatedExecute !== true) return codes.authenticatedAcl;
  return null;
}

export function assertPostgresFunctionDiagnosticMatrix(assert, baseRow, expected, codes) {
  assert.equal(diagnosePostgresFunctionContract(baseRow, expected, codes), null);

  const configWithout = (key) => baseRow.config.filter((entry) => !entry.startsWith(`${key}=`));
  const failures = [
    ['signature resolution missing', { resolved: false }, codes.signatureMissing],
    ['wrong schema', { schemaName: 'private' }, codes.signature],
    ['wrong function name', { functionName: `${expected.functionName}_shadow` }, codes.signature],
    ['unknown overload', { overloadCount: 2 }, codes.overload],
    ['wrong argument count', { argumentCount: 1 }, codes.argumentCount],
    ['wrong first argument type', { argumentTypes: `23 ${expected.argumentTypes[1]}` }, codes.argumentTypes],
    ['wrong second argument type', { argumentTypes: `${expected.argumentTypes[0]} 25` }, codes.argumentTypes],
    ['wrong first argument name', { argumentNames: ['idempotency_key', expected.argumentNames[1]] }, codes.argumentNames],
    ['wrong second argument name', { argumentNames: [expected.argumentNames[0], 'request'] }, codes.argumentNames],
    ['wrong return type', { returnType: POSTGRES_TYPE_OIDS.text }, codes.returnType],
    ['wrong prokind', { kind: 'p' }, codes.kind],
    ['wrong owner', { ownerRole: 'unexpected_owner' }, codes.owner],
    ['wrong security mode', { securityDefiner: false }, codes.securityDefiner],
    ['wrong search path', { config: [...configWithout('search_path'), 'search_path='] }, codes.config.search_path],
    ['missing search path', { config: configWithout('search_path') }, codes.config.search_path],
    ['PUBLIC execute granted', { publicExecute: true }, codes.publicAcl],
    ['anon execute granted', { anonExecute: true }, codes.anonAcl],
    ['authenticated execute missing', { authenticatedExecute: false }, codes.authenticatedAcl],
  ];

  if (Object.hasOwn(expected.configValues, 'statement_timeout')) {
    failures.push(
      ['wrong statement timeout', {
        config: [...configWithout('statement_timeout'), 'statement_timeout=30s'],
      }, codes.config.statement_timeout],
      ['missing statement timeout', {
        config: configWithout('statement_timeout'),
      }, codes.config.statement_timeout],
    );
  }

  for (const [label, patch, expectedCode] of failures) {
    assert.equal(
      diagnosePostgresFunctionContract({ ...baseRow, ...patch }, expected, codes),
      expectedCode,
      `${label} must fail closed with its diagnostic code`,
    );
  }
}
