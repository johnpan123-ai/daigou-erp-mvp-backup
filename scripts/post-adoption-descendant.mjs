import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const policy = JSON.parse(readFileSync(new URL('../config/erp2-non-schema-release-policy.json', import.meta.url), 'utf8'));
const fail = message => { throw new Error(`DEPLOYMENT_GUARD_FAILED_CLOSED: ${message}`); };
const hash = source => createHash('sha256').update(source).digest('hex');
const sha = value => /^[0-9a-f]{40}$/u.test(value ?? '');
const print = ts.createPrinter({ removeComments: true });
const parse = (file, source) => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) fail(`unparseable descendant source: ${file}`);
  return tree;
};
const canonical = (tree, node = tree) => print.printNode(ts.EmitHint.Unspecified, node, tree);
const isJsx = node => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
const nodes = tree => {
  const result = [];
  const visit = node => { result.push(node); ts.forEachChild(node, visit); };
  visit(tree); return result;
};

// New helper is restricted to this existing provider-availability predicate.
// It cannot become a payload builder, quantity calculation or persistence wrapper.
const pureSupportSource = `import type { ProviderMode } from '../providers/providerMode';
import { STAGING_SUPABASE_PROJECT_REF } from '../lib/supabaseEnvironmentBoundary';
export function supportsWacaProvider(mode: ProviderMode, cloudProjectRef: string): boolean {
  return mode === 'next' || ((mode === 'cloud' || mode === 'fallback')
    && cloudProjectRef === STAGING_SUPABASE_PROJECT_REF);
}`;

const presentationImports = new Set([
  "import { supportsWacaProvider } from '../../waca/providerSupport';",
  "import { supportsWacaProvider } from '../waca/providerSupport';",
  "import { supabaseEnvironment } from '../providers/cloud/supabaseClient';",
].map(source => canonical(parse('import.ts', source)).trim()));
const readMethods = new Set(['getProductGroups', 'getNextWacaSnapshot', 'getAuthoritativeWacaVariants', 'getInventory']);

function assertReadPresentation(node, tree) {
  if (nodes(node).some(value => ts.isBinaryExpression(value)
    && value.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && value.operatorToken.kind <= ts.SyntaxKind.LastAssignment)) fail('presentation loader contains assignment side effects');
  for (const call of nodes(node).filter(ts.isCallExpression)) {
    const name = canonical(tree, call.expression).trim();
    const constantArrayIncludes = ts.isPropertyAccessExpression(call.expression)
      && call.expression.name.text === 'includes' && ts.isArrayLiteralExpression(call.expression.expression)
      && call.expression.expression.elements.every(ts.isStringLiteral);
    const promiseContinuation = ts.isPropertyAccessExpression(call.expression)
      && ['then', 'catch'].includes(call.expression.name.text) && name.startsWith('Promise.');
    if (name.startsWith('dataProvider.')) {
      if (!readMethods.has(name.slice('dataProvider.'.length))) fail('presentation loader changes provider write semantics');
    } else if (!constantArrayIncludes && !/^(?:useCallback|load|setSnapshot|setVariants|setInventory|setGroups|setError|readErrorText|getProviderMode|supportsWacaProvider|String|Promise\.resolve|Promise\.all)$/u.test(name)
      && !promiseContinuation) fail(`unreviewed presentation loader call: ${name}`);
  }
}

// Only JSX/presentation, safe error display and the known read-only loader may
// differ. All other runtime statements (including quantity/matcher/payload
// builders, mutation handlers and imported contracts) stay AST-identical.
export function uiProjection(file, source) {
  const tree = parse(file, source);
  const persistenceCalls = nodes(tree).filter(ts.isCallExpression).filter(call =>
    /(?:dataProvider|supabase|indexedDB|localStorage|sessionStorage|\bdb\b|\brepo\b|fetch|sendBeacon)/u
      .test(canonical(tree, call.expression)))
    .filter(call => !readMethods.has(canonical(tree, call.expression).replace(/^dataProvider\./u, '').trim()))
    .map(call => canonical(tree, call));
  const transformer = context => {
    const visit = node => {
      if (ts.isImportDeclaration(node) && presentationImports.has(canonical(tree, node).trim())) return undefined;
      if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
        const declaration = node.declarationList.declarations[0];
        if (file === 'src/pages/WacaIntegration.tsx' && ['load', 'readErrorText'].includes(declaration.name.getText(tree))) {
          assertReadPresentation(declaration, tree); return undefined;
        }
      }
      if (file === 'src/pages/WacaIntegration.tsx' && ts.isExpressionStatement(node)
        && ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'useEffect'
        && node.getText(tree).includes('load')) {
        assertReadPresentation(node.expression.arguments[0], tree); return undefined;
      }
      if (ts.isIfStatement(node) && ts.isReturnStatement(node.thenStatement)
        && node.thenStatement.expression && isJsx(node.thenStatement.expression)
        && /getProviderMode|supportsWacaProvider/u.test(node.expression.getText(tree))) {
        assertReadPresentation(node.expression, tree); return undefined;
      }
      if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useMemo'
        && node.arguments[0] && ts.isArrowFunction(node.arguments[0]) && isJsx(node.arguments[0].body)) {
        if (node.arguments[1] && nodes(node.arguments[1]).some(ts.isCallExpression)) fail('UI memo dependencies contain runtime calls');
        return ts.factory.updateCallExpression(node, node.expression, node.typeArguments,
          [ts.factory.createArrowFunction(undefined, undefined, [], undefined, undefined, ts.factory.createNull()), ts.factory.createArrayLiteralExpression()]);
      }
      if (isJsx(node)) return ts.factory.createNull();
      return ts.visitEachChild(node, visit, context);
    };
    return root => ts.visitNode(root, visit);
  };
  const transformed = ts.transform(tree, [transformer]);
  const runtime = canonical(tree, transformed.transformed[0]);
  transformed.dispose();
  return { runtime, persistenceCalls };
}

const preservedGuardFunctions = [
  'assertCanonicalContract', 'verifyPlannerContract', 'verifyLiveObservation', 'verifyPreAdoption',
  'validatePublicTarget', 'verifyLocalCandidate', 'verifyRemoteCandidate',
  'verifyCloudflareIdentity', 'verifyPromotionIdentity', 'verifyArtifactIdentity',
];
function guardFunctionSource(source, name) {
  const tree = parse('guard.mjs', source);
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    ?? tree.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
      .find(node => node.name.getText(tree) === name);
  if (!declaration) fail(`required guard invariant missing: ${name}`);
  return canonical(tree, declaration);
}

export function classifyDescendantFile(file, before, after) {
  if (!file || file.includes('..') || file.includes('\\') || file.startsWith('/')) fail('invalid changed file path');
  if (policy.purePresentationFiles.includes(file)) {
    if (after === null || canonical(parse(file, after)) !== canonical(parse(file, pureSupportSource))) {
      return 'SCHEMA_SENSITIVE_OR_UNREVIEWED';
    }
    return 'PURE_PRESENTATION';
  }
  if (policy.uiFiles.includes(file)) {
    if (before === null || after === null) return 'SCHEMA_SENSITIVE_OR_UNREVIEWED';
    try {
      return JSON.stringify(uiProjection(file, before)) === JSON.stringify(uiProjection(file, after))
        ? 'UI_PRESENTATION' : 'SCHEMA_SENSITIVE_OR_UNREVIEWED';
    } catch { return 'SCHEMA_SENSITIVE_OR_UNREVIEWED'; }
  }
  if (file === 'package.json') {
    if (before === null || after === null) return 'SCHEMA_SENSITIVE_OR_UNREVIEWED';
    const oldPackage = JSON.parse(before); const newPackage = JSON.parse(after);
    const { scripts: oldScripts, ...oldRest } = oldPackage;
    const { scripts: newScripts, ...newRest } = newPackage;
    if (JSON.stringify(oldRest) !== JSON.stringify(newRest)
      || Object.entries(oldScripts).some(([key, value]) => newScripts[key] !== value)
      || Object.entries(newScripts).some(([key, value]) => !(key in oldScripts)
        && (!key.startsWith('test:') || !/^node tests\/[a-z0-9-]+\.mjs$/u.test(value)))) return 'SCHEMA_SENSITIVE_OR_UNREVIEWED';
    return 'TEST_SCRIPT_ADDITIONS';
  }
  if (policy.releaseControlFiles.includes(file)) {
    if (after === null) return 'SCHEMA_SENSITIVE_OR_UNREVIEWED';
    if (file === 'scripts/promotion-safety.mjs' && before !== null
      && preservedGuardFunctions.some(name => guardFunctionSource(before, name) !== guardFunctionSource(after, name))) {
      return 'SCHEMA_SENSITIVE_OR_UNREVIEWED';
    }
    return 'RELEASE_CONTROL_PLANE';
  }
  if (file.endsWith('.sql') || policy.schemaContractFiles.includes(file)
    || policy.schemaSensitivePrefixes.some(prefix => file.startsWith(prefix))) return 'SCHEMA_SENSITIVE_OR_UNREVIEWED';
  if (policy.nonRuntimePrefixes.some(prefix => file.startsWith(prefix))) return 'NON_RUNTIME_TEST_OR_DOC';
  if (file.endsWith('.css') && policy.stylePrefixes.some(prefix => file.startsWith(prefix))) return 'UI_STYLE';
  return policy.defaultClassification;
}

export function verifySafeDescendant({ git, candidate, baselineRecord }) {
  const baseline = baselineRecord?.sourceHead;
  if (!sha(baseline) || !sha(candidate?.head) || !baselineRecord.checkpoint?.startsWith('checkpoint-')) fail('invalid schema baseline Git identity');
  if (git(['rev-parse', `${baselineRecord.checkpoint}^{}`]).trim() !== baseline) fail('local schema baseline checkpoint mismatch');
  const remote = git(['ls-remote', 'origin', `refs/tags/${baselineRecord.checkpoint}`, `refs/tags/${baselineRecord.checkpoint}^{}`]);
  const refs = new Map(remote.trim().split(/\r?\n/u).filter(Boolean).map(row => {
    const [head, ref] = row.split(/\s+/u); return [ref, head];
  }));
  if ((refs.get(`refs/tags/${baselineRecord.checkpoint}^{}`) ?? refs.get(`refs/tags/${baselineRecord.checkpoint}`)) !== baseline) {
    fail('remote schema baseline checkpoint missing or mismatched');
  }
  try { git(['--no-replace-objects', 'merge-base', '--is-ancestor', baseline, candidate.head]); }
  catch { fail('candidate is not a schema baseline descendant'); }
  const oldFiles = git(['ls-tree', '-r', '--name-only', baseline]).trim().split(/\r?\n/u).filter(Boolean);
  const newFiles = git(['ls-tree', '-r', '--name-only', candidate.head]).trim().split(/\r?\n/u).filter(Boolean);
  const oldSet = new Set(oldFiles); const newSet = new Set(newFiles);
  const source = (head, file, exists) => exists ? git(['show', `${head}:${file}`]) : null;
  const changed = git(['diff', '--name-only', '--no-renames', baseline, candidate.head, '--']).trim().split(/\r?\n/u).filter(Boolean);
  const classified = changed.map(file => ({ file,
    classification: classifyDescendantFile(file, source(baseline, file, oldSet.has(file)), source(candidate.head, file, newSet.has(file))),
  }));
  const sensitive = classified.filter(row => row.classification === 'SCHEMA_SENSITIVE_OR_UNREVIEWED');
  const migrations = [...new Set([...oldFiles, ...newFiles].filter(file => file.endsWith('.sql')))];
  const checksumParity = migrations.every(file => oldSet.has(file) && newSet.has(file)
    && hash(source(baseline, file, true)) === hash(source(candidate.head, file, true)));
  const canonicalFiles = [...new Set([...oldFiles, ...newFiles].filter(file =>
    file.startsWith('tools/schema-reconciliation/') || policy.schemaContractFiles.includes(file)))];
  const canonicalParity = canonicalFiles.every(file => oldSet.has(file) && newSet.has(file)
    && hash(source(baseline, file, true)) === hash(source(candidate.head, file, true)));
  if (!checksumParity) fail('migration/source SQL checksum changed since adopted baseline');
  if (!canonicalParity) fail('canonical schema/fingerprint contract changed since adopted baseline');
  if (sensitive.length) fail(`schema-sensitive or unreviewed descendant diff: ${sensitive.map(row => row.file).join(', ')}`);
  return {
    result: 'PASS', mode: baseline === candidate.head ? 'EXACT_BASELINE' : 'SAFE_DESCENDANT',
    baselineHead: baseline, baselineCheckpoint: baselineRecord.checkpoint,
    candidateHead: candidate.head, candidateCheckpoint: candidate.checkpointTag,
    ancestry: 'PASS', schemaSensitiveFiles: 0, nonSchemaFiles: classified.length,
    migrationChecksumParity: 'PASS', migrationFiles: migrations.length,
    canonicalContractParity: 'PASS', changedFiles: classified,
    schemaBaselineMutated: false,
  };
}
