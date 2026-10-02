import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { classifyReviewedFile, reviewForCandidate, sourceHash, verifyImpactEvidence } from './reviewed-change-impact.mjs';

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

// Exact patch hashes remain mandatory. These structural checks additionally
// prove the reviewed provider patch did not change its external schema/RPC
// contract. This is not a provider-directory allowlist.
export function assertReviewedProviderContract(file, before, after) {
  if (file === 'src/providers/cloud/inventoryImportPlan.ts') {
    // Only the exact immutable review can select this helper. It has no new
    // provider API, serializer, SQL fields or network/persistence calls.
    if (before !== null) fail('inventory import planner must be reviewed as a new pure helper');
    const tree = parse(file, after);
    const declarations = tree.statements.filter(ts.isFunctionDeclaration);
    if (declarations.length !== 1 || declarations[0].name?.text !== 'planCloudInventoryImport') {
      fail('unreviewed inventory planner API');
    }
    for (const call of nodes(tree).filter(ts.isCallExpression)) {
      if (/supabase|fetch|indexedDB|localStorage|\bdb\b|\.rpc|\.from/u.test(canonical(tree, call.expression))) {
        fail('inventory identity planner contains I/O');
      }
    }
    return;
  }
  const oldTree = parse(file, before); const newTree = parse(file, after);
  if (file === 'src/providers/cloud/cloudFieldCas.ts') {
    const statements = new Set(newTree.statements.map(node => canonical(newTree, node)));
    if (oldTree.statements.some(node => !statements.has(canonical(oldTree, node)))) fail('existing field/CAS contract changed');
    return;
  }
  const allowedMethods = {
    'src/providers/cloud/supabaseProvider.ts': ['applyCloudFieldMutations', 'updateProductVariantPatch', 'updateProductVariantPatchBulk', 'savePrivateOrders', 'upsertInventory'],
    'src/providers/dataProvider.ts': ['updateProductVariantPatch', 'updateProductVariantPatchBulk'],
    'src/providers/localProvider.ts': ['updateProductVariantPatch', 'updateProductVariantPatchBulk'],
  }[file];
  if (!allowedMethods) fail('unreviewed provider contract exception');
  const findClass = tree => tree.statements.find(node => ts.isClassDeclaration(node)
    && node.members.some(member => member.name?.getText(tree) === 'updateProductVariantPatch'));
  const oldClass = findClass(oldTree); const newClass = findClass(newTree);
  if (!oldClass || !newClass) fail('provider class missing');
  const members = (tree, node) => node.members.filter(member => !allowedMethods.includes(member.name?.getText(tree)))
    .map(member => canonical(tree, member));
  if (JSON.stringify(members(oldTree, oldClass)) !== JSON.stringify(members(newTree, newClass))) fail('unreviewed provider member changed');
  const rpc = tree => nodes(tree).filter(ts.isCallExpression).filter(node => node.expression.getText(tree) === 'supabase.rpc')
    .map(node => canonical(tree, node));
  if (JSON.stringify(rpc(oldTree)) !== JSON.stringify(rpc(newTree))) fail('provider RPC signature/payload changed');
}

export function inspectSafeDescendant({ git, candidate, baselineRecord }) {
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
  const sources = new Map();
  const source = (head, file, exists) => {
    if (!exists) return null;
    const key = `${head}:${file}`;
    if (!sources.has(key)) sources.set(key, git(['show', key]));
    return sources.get(key);
  };
  const changed = git(['diff', '--name-only', '--no-renames', baseline, candidate.head, '--']).trim().split(/\r?\n/u).filter(Boolean);
  // Validate the full immutable review history, then classify only patches
  // after this adopted baseline. Earlier accepted patches are already part of
  // its tree, not a pre-patch gap in a later release. No path/hash exemption.
  const reviews = reviewForCandidate(git, candidate.head, baseline).filter(review => {
    try { git(['--no-replace-objects', 'merge-base', '--is-ancestor', review.reviewedHead, baseline]); }
    catch { return true; }
    return false;
  });
  const usedReviews = new Set();
  const classified = changed.map(file => {
    const before = source(baseline, file, oldSet.has(file));
    const after = source(candidate.head, file, newSet.has(file));
    const reviewed = classifyReviewedFile({ file, after, reviews });
    if (reviewed) {
      // Preserve the original UI-only guard for the earlier baseline ->
      // deployed interval. Only the exact separately-reviewed patch is new.
      const first = reviewed.chain[0];
      const previous = first.row.beforeHash === null ? null : git(['show', `${first.review.beforeHead}:${file}`]);
      if (sourceHash(before) !== sourceHash(previous)
        && classifyDescendantFile(file, before, previous) === 'SCHEMA_SENSITIVE_OR_UNREVIEWED') fail(`unreviewed pre-patch source: ${file}`);
      reviewed.chain.forEach(entry => usedReviews.add(entry.review.id));
      return { ...reviewed.row, beforeHash: sourceHash(before), reviewedBeforeHash: reviewed.row.beforeHash,
        reviewId: reviewed.review.id, reviewIds: reviewed.chain.map(entry => entry.review.id),
        functions: [...new Set(reviewed.chain.flatMap(entry => entry.row.functions))] };
    }
    return { file, classification: classifyDescendantFile(file, before, after), beforeHash: sourceHash(before), afterHash: sourceHash(after) };
  });
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
  const contractParity = predicate => [...new Set([...oldFiles, ...newFiles].filter(predicate))].every(file =>
    oldSet.has(file) && newSet.has(file) && sourceHash(source(baseline, file, true)) === sourceHash(source(candidate.head, file, true)));
  const backupParity = contractParity(file => /(?:durableResourceRegistry|workbenchJsonBackup|closingDateSidecarBackup|backupFormat|CloudAtomicRestore|cloudAtomicRestore)/u.test(file));
  const providerFiles = [...new Set([...oldFiles, ...newFiles].filter(file => file.startsWith('src/providers/')))];
  const providerParity = providerFiles.every(file => {
    if (!newSet.has(file)) return false;
    const before = source(baseline, file, oldSet.has(file)); const after = source(candidate.head, file, true);
    if (sourceHash(before) === sourceHash(after)) return true;
    const reviewed = classifyReviewedFile({ file, after, reviews });
    if (!reviewed || reviewed.row.classification !== 'PERSISTENCE_BEHAVIOR_SCHEMA_NEUTRAL') return false;
    assertReviewedProviderContract(file, before, after);
    return true;
  });
  if (!backupParity) fail('backup/restore resource contract changed');
  if (!providerParity) fail('provider persistence/schema contract changed');
  const requiredRegressions = [...new Set(reviews.filter(review => usedReviews.has(review.id)).flatMap(review => review.requiredRegressions))];
  return {
    result: 'PASS', mode: baseline === candidate.head ? 'EXACT_BASELINE' : 'SAFE_DESCENDANT',
    baselineHead: baseline, baselineCheckpoint: baselineRecord.checkpoint,
    candidateHead: candidate.head, candidateCheckpoint: candidate.checkpointTag, candidateBranch: candidate.branch ?? null,
    ancestry: 'PASS', schemaSensitiveFiles: 0, nonSchemaFiles: classified.length,
    migrationChecksumParity: 'PASS', migrationFiles: migrations.length,
    canonicalContractParity: 'PASS', backupContractParity: 'PASS', providerContractParity: 'PASS', changedFiles: classified,
    persistenceSchemaNeutralFiles: classified.filter(row => row.classification === 'PERSISTENCE_BEHAVIOR_SCHEMA_NEUTRAL').length,
    unknownFiles: 0, requiredRegressions,
    schemaBaselineMutated: false,
  };
}

export function verifySafeDescendant({ git, candidate, baselineRecord, changeImpactEvidence, now }) {
  const inspection = inspectSafeDescendant({ git, candidate, baselineRecord });
  const regressionEvidence = verifyImpactEvidence({ evidence: changeImpactEvidence, inspection, git, now });
  return { ...inspection, regressionEvidence };
}
