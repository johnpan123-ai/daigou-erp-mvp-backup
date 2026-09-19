export const POSTGRES_TYPE_OIDS = Object.freeze({
  uuid: 2950,
  jsonb: 3802,
});

export function evaluatePostgresFunctionContract(row, expected) {
  const mismatches = [];
  const check = (condition, label) => {
    if (!condition) mismatches.push(label);
  };

  check(row.resolved === true, 'signature-resolution');
  check(row.schemaName === expected.schemaName, 'schema');
  check(row.functionName === expected.functionName, 'function-name');
  check(row.overloadCount === 1, 'unknown-overload');
  check(row.argumentCount === expected.argumentTypes.length, 'argument-count');
  check(
    Array.isArray(row.argumentTypes)
      && row.argumentTypes.length === expected.argumentTypes.length
      && row.argumentTypes.every((value, index) => value === expected.argumentTypes[index]),
    'argument-types',
  );
  check(
    Array.isArray(row.argumentNames)
      && row.argumentNames.length === expected.argumentNames.length
      && row.argumentNames.every((value, index) => value === expected.argumentNames[index]),
    'argument-names',
  );
  check(row.returnType === expected.returnType, 'return-type');
  check(row.kind === 'f', 'prokind');
  check(row.securityDefiner === true, 'security-definer');
  check(row.ownerMatchesCurrentUser === true, 'owner');
  check(
    expected.requiredConfig.every((entry) => row.config?.includes(entry)),
    'function-config',
  );
  check(row.publicExecute === false, 'public-acl');
  check(row.anonExecute === false, 'anon-acl');
  check(row.authenticatedExecute === true, 'authenticated-acl');

  return mismatches;
}

export function assertPostgresFunctionContractMatrix(assert, baseRow, expected) {
  assert.deepEqual(evaluatePostgresFunctionContract(baseRow, expected), []);

  const failures = [
    ['signature resolution missing', { resolved: false }, 'signature-resolution'],
    ['wrong schema', { schemaName: 'private' }, 'schema'],
    ['wrong function name', { functionName: `${expected.functionName}_shadow` }, 'function-name'],
    ['wrong first argument type', { argumentTypes: [23, expected.argumentTypes[1]] }, 'argument-types'],
    ['wrong second argument type', { argumentTypes: [expected.argumentTypes[0], 25] }, 'argument-types'],
    ['wrong argument count', { argumentCount: 1 }, 'argument-count'],
    ['unknown overload', { overloadCount: 2 }, 'unknown-overload'],
    ['wrong return type', { returnType: 25 }, 'return-type'],
    ['wrong prokind', { kind: 'p' }, 'prokind'],
    ['wrong security mode', { securityDefiner: false }, 'security-definer'],
    ['wrong owner', { ownerMatchesCurrentUser: false }, 'owner'],
    ['wrong search path', { config: baseRow.config.filter((entry) => entry !== 'search_path=') }, 'function-config'],
    ['PUBLIC execute granted', { publicExecute: true }, 'public-acl'],
    ['anon execute granted', { anonExecute: true }, 'anon-acl'],
    ['authenticated execute missing', { authenticatedExecute: false }, 'authenticated-acl'],
    ['wrong argument names', { argumentNames: ['idempotency_key', 'request'] }, 'argument-names'],
  ];

  for (const [label, patch, expectedMismatch] of failures) {
    const mismatches = evaluatePostgresFunctionContract({ ...baseRow, ...patch }, expected);
    assert.ok(mismatches.includes(expectedMismatch), `${label} must fail closed`);
  }
}
