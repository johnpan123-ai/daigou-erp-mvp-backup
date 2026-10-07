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
// Only this verified legacy-adapter patch may differ from the adopted Backup
// source. It cannot change collections, serializers, RPCs or any other code.
// The caller also requires an immutable before/after hash review and tests.
export function assertReviewedRestoreAdapterContract(file, before, after) {
  if (file !== 'src/providers/cloud/cloudAtomicRestore.ts' || before === null || after === null) {
    fail('unreviewed Restore adapter contract exception');
  }
  const legacyAddition = canonical(parse(file, `
    for (const row of normalized.outbound_shipments) {
      if (!('status_changed_at' in row)) row.status_changed_at = null;
    }
  `)).trim();
  const afterTree = parse(file, after);
  const removals = [];
  for (const addition of [legacyAddition]) {
    const matches = nodes(afterTree).filter(node => ts.isStatement(node)
      && canonical(afterTree, node).trim() === addition);
    if (matches.length !== 1) fail('Restore adapter approved statement missing or repeated');
    removals.push({ start: matches[0].getStart(afterTree), end: matches[0].end });
  }
  let reviewed = after;
  for (const range of removals.sort((a,b) => b.start-a.start)) {
    reviewed = reviewed.slice(0, range.start) + reviewed.slice(range.end);
  }
  if (canonical(parse(file, reviewed)) !== canonical(parse(file, before))) {
    fail('Restore schema/resource/RPC or unreviewed adapter contract changed');
  }
}

export function assertReviewedRestoreOrchestrationContract(file, before, after) {
  if (before === null || after === null) fail('Restore orchestration requires an existing exact reviewed source');
  let restored = after;
  if (file === 'src/providers/cloud/cloudRestoreSubmit.ts') {
    restored = after.replace('  options: { newIntent?: boolean } = {},\n', '')
      .replace('if (existing && !options.newIntent)', 'if (existing)')
      .replace('if (identity && !options.newIntent)', 'if (identity)');
  } else if (file === 'src/providers/cloud/cloudRestoreStagedUpload.ts') {
    restored = after.replace('batch.length === 2 || batchBytes + bytes > 512 * 1024',
      'batch.length === 4 || batchBytes + bytes > 1024 * 1024')
      .replace('Array.from({ length: 2 }', 'Array.from({ length: 4 }');
  } else if (file === 'src/components/CloudAtomicRestorePanel.tsx') {
    // Immutable before/after review hashes gate this branch. Independently
    // preserve every provider/Restore port call and its complete payload.
    const ports = source => {
      const tree = parse(file, source);
      return nodes(tree).filter(ts.isCallExpression).filter(node =>
        /dataProvider\.|executeRestore|checkRestoreOutcome|prepareCloudRestore|verifyCloudRestore|refreshAuthoritative|restoreCloudDeadline/u
          .test(node.expression.getText(tree))).map(node => canonical(tree, node));
    };
    if (JSON.stringify(ports(before)) !== JSON.stringify(ports(after))) {
      fail('Restore orchestration changed a provider/RPC/proof/readback payload');
    }
    return;
  } else fail('unreviewed Restore orchestration file');
  if (canonical(parse(file, before)) !== canonical(parse(file, restored))) {
    fail('Restore transport/storage/RPC contract changed beyond exact orchestration');
  }
}

export function assertReviewedProviderContract(file, before, after) {
  if (['src/providers/cloud/cloudRestoreSubmit.ts', 'src/providers/cloud/cloudRestoreStagedUpload.ts'].includes(file)) {
    assertReviewedRestoreOrchestrationContract(file, before, after);
    return;
  }
  if (file === 'src/providers/cloud/cloudAtomicRestore.ts') {
    assertReviewedRestoreAdapterContract(file, before, after);
    return;
  }
  if (file === 'src/providers/cloud/buyAnimeImportCoordinator.ts') {
    if (before !== null) fail('coordinator needs a new exact review');
    const tree=parse(file,after);
    if(nodes(tree).filter(ts.isCallExpression).some(call=>/^(?:supabase\.|fetch|indexedDB\.|localStorage\.|sessionStorage\.|db\.)/u.test(call.expression.getText(tree))))
      fail('import coordinator contains persistence I/O');
    return;
  }
  if (file === 'src/providers/cloud/catalogTransaction.ts') {
    // Exact reviewed patches may change the transient FULL-registry guard count
    // and add Product Master as an application planning strategy. `master`
    // must still serialize through the already-adopted `sync` wire mode; it
    // cannot introduce a new RPC, field, collection or payload contract.
    const tree = parse(file, after);
    const masterBranch = nodes(tree).filter(ts.isIfStatement).filter(node =>
      node.expression.getText(tree) === "mode==='master'"
      && node.thenStatement.getText(tree) === 'await ensureProductMasterFromInventory.call(ctx,itemCodes);');
    const masterWireMode = nodes(tree).filter(ts.isConditionalExpression).filter(node =>
      node.condition.getText(tree) === "mode==='master'"
      && node.whenTrue.getText(tree) === "'sync'"
      && node.whenFalse.getText(tree) === 'mode');
    const hasMasterMode = after.includes("'master'");
    if (hasMasterMode && (masterBranch.length !== 1 || masterWireMode.length !== 1)) {
      fail('Catalog Product Master must use the adopted sync wire contract');
    }
    const restored=after
      .replace('createPurchaseRecordFromInventory,ensureProductMasterFromInventory,reparseProductVariants',
        'createPurchaseRecordFromInventory,reparseProductVariants')
      .replace("export type CatalogMode='create'|'master'|'sync'|'reparse';",
        "export type CatalogMode='create'|'sync'|'reparse';")
      .replace("  else if(mode==='master') await ensureProductMasterFromInventory.call(ctx,itemCodes);\n", '')
      .replace("mode:mode==='master'?'sync':mode", 'mode');
    if (canonical(parse(file,before)) === canonical(parse(file,restored))) return;
    // Earlier exact review: only the transient FULL-registry guard count was
    // added. Keep this path separate so a Product Master review cannot absorb
    // another unrelated Catalog change.
    const transientGuardRestored=after
      .replace(", options: { baselineVariantCount?: number } = {}",'')
      .replace('(options.baselineVariantCount ?? base.variants.length)===0','base.variants.length===0')
      .replace('const baselineCount=options.baselineVariantCount ?? before.length;','')
      .replace('baselineCount>0','before.length>0')
      .replace('Math.ceil(baselineCount*0.25)','Math.ceil(before.length*0.25)');
    if(canonical(parse(file,before))!==canonical(parse(file,transientGuardRestored))) fail('Catalog algorithm/RPC contract changed');
    return;
  }
  if (file === 'src/providers/cloud/cloudBulkRead.ts') {
    if (before !== null) fail('new readback/resume helper needs a new exact review');
    const tree=parse(file,after);
    if (nodes(tree).filter(ts.isCallExpression).some(call =>
      /^(?:supabase\.|fetch|indexedDB\.|localStorage\.|sessionStorage\.|db\.)/u.test(call.expression.getText(tree))))
      fail('pure readback/resume helper contains direct persistence I/O');
    return;
  }
  if (file === 'src/providers/cloud/buyAnimeImportResume.ts') {
    // Later exact reviews may refine the coordinator state machine, but it
    // must remain a port-only domain helper with no direct persistence API.
    const tree=parse(file,after);
    if (nodes(tree).filter(ts.isCallExpression).some(call =>
      /^(?:supabase\.|fetch|indexedDB\.|localStorage\.|sessionStorage\.|db\.)/u.test(call.expression.getText(tree))))
      fail('pure readback/resume helper contains direct persistence I/O');
    return;
  }
  if (file === 'src/providers/cloud/buyAnimeImportJournal.ts') {
    if (before !== null) {
      const restored = after
        .replace(' || header.restoreEpoch !== record.restoreEpoch', '')
        .replace(/,\s*\.\.\.\(next\.restoreEpoch !== undefined \? \{ restoreEpoch: next\.restoreEpoch \} : \{\}\)/u, '');
      if (canonical(parse(file, before)) !== canonical(parse(file, restored))) fail('journal optional generation patch needs a new exact review');
    }
    const tree=parse(file,after);
    for (const call of nodes(tree).filter(ts.isCallExpression)) {
      const name=call.expression.getText(tree);
      if (name==='supabase.rpc' || /^(?:fetch|indexedDB\.|localStorage\.|sessionStorage\.|db\.)/u.test(name))
        fail('optional journal contains another persistence contract');
      if (name==='supabase.from' && (call.arguments.length!==1 || !ts.isStringLiteral(call.arguments[0])
        || call.arguments[0].text!=='import_batches')) fail('journal resource changed');
    }
    return;
  }
  if (file === 'src/providers/cloud/buyAnimeRecoveryEpoch.ts') {
    if (before !== null) fail('recovery epoch helper needs a new exact review');
    const tree = parse(file, after);
    for (const call of nodes(tree).filter(ts.isCallExpression)) {
      const name = call.expression.getText(tree);
      if (name === 'supabase.rpc' || /^(?:fetch|indexedDB\.|localStorage\.|sessionStorage\.|db\.)/u.test(name)
        || /\.(?:insert|update|upsert|delete|put|add|clear|createObjectStore|deleteDatabase)$/u.test(name))
        fail('recovery generation helper must be SELECT-only');
      if (name === 'supabase.from' && (call.arguments.length !== 1 || !ts.isStringLiteral(call.arguments[0])
        || call.arguments[0].text !== 'erp_cloud_restore_epoch')) fail('recovery generation resource changed');
      if (name.endsWith('.select') && (call.arguments.length !== 1 || !ts.isStringLiteral(call.arguments[0])
        || call.arguments[0].text !== 'epoch,restored_at')) fail('recovery generation read contract changed');
    }
    return;
  }
  if (file === 'src/providers/cloud/cloudSyncDomain.ts') {
    const stripped=after.replace(/\/\*\* Transient acknowledgement proof; never a durable field or Realtime payload\. \*\/\s*expectedFields\?: Record<string, unknown>;/u,'');
    if (canonical(parse(file,before))!==canonical(parse(file,stripped))) fail('sync runtime contract changed');
    return;
  }
  if (file === 'src/providers/cloud/cloudTargetedCache.ts') {
    const restored=after.replace("if (isAuthoritativeResourceRead || (previousStatus !== 'fresh-online' && previousStatus !== 'fresh-empty'))",
      "if ((!this.protectsDraft && !this.prepareDraftProtection) || (previousStatus !== 'fresh-online' && previousStatus !== 'fresh-empty'))");
    const oldTree=parse(file,before),newTree=parse(file,restored);
    const absorbed=nodes(newTree).filter(ts.isMethodDeclaration)
      .find(member=>member.name?.getText(newTree)==='absorbVerifiedRows');
    if (!absorbed) fail('verified-row cache absorption contract missing');
    const absorbedSource=canonical(newTree,absorbed);
    for (const required of ['assertExpectedCloudFields','this.merge','markCloudReadFresh']) {
      if (!absorbedSource.includes(required)) fail('verified-row cache evidence validation changed');
    }
    if (/supabase|fetch|readCloudRowsByIds|\.refresh(?:WithResult)?\(/u.test(absorbedSource)) {
      fail('verified-row cache absorption performs an unreviewed read');
    }
    const members=tree=>nodes(tree).filter(ts.isClassDeclaration).flatMap(node=>node.members)
      .filter(member=>!['refreshChanges','absorbVerifiedRows'].includes(member.name?.getText(tree))).map(member=>canonical(tree,member));
    if(JSON.stringify(members(oldTree))!==JSON.stringify(members(newTree)))fail('draft/generation/cache contract changed');
    return;
  }
  if (file === 'src/providers/cloud/inventoryImportPlan.ts') {
    // Only the exact immutable review can select this helper. It has no new
    // provider API, serializer, SQL fields or network/persistence calls.
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
  if (file === 'src/providers/types.ts') {
    if (before === null) fail('provider interface needs a new exact review');
    const tree = parse(file, after);
    const methods = nodes(tree).filter(ts.isMethodSignature).filter(node =>
      node.name.getText(tree) === 'ensureProductMasterFromInventory');
    if (methods.length !== 1
      || canonical(tree, methods[0]) !== 'ensureProductMasterFromInventory(itemCodes: string[]): Promise<void>;') {
      fail('Product Master provider interface contract changed');
    }
    const restored = after.replace(/\s*ensureProductMasterFromInventory\(itemCodes: string\[\]\): Promise<void>;/u, '');
    if (canonical(parse(file, before)) !== canonical(parse(file, restored))) {
      fail('unreviewed provider interface member changed');
    }
    return;
  }
  if (before === null) fail('unreviewed provider contract exception');
  const oldTree = parse(file, before); const newTree = parse(file, after);
  if (file === 'src/providers/cloud/cloudFieldCas.ts') {
    const statements = new Set(newTree.statements.map(node => canonical(newTree, node)));
    if (oldTree.statements.some(node => !statements.has(canonical(oldTree, node)))) fail('existing field/CAS contract changed');
    return;
  }
  const allowedMethods = {
    'src/providers/cloud/supabaseProvider.ts': ['applyCloudFieldMutations', 'updateProductVariantPatch', 'updateProductVariantPatchBulk', 'savePrivateOrders', 'upsertInventory',
      'refreshAcknowledgedCloudRows','savePrivateOrderItems','buyAnimePipeline','readActiveCatalogTable','readCloudIds','readBuyAnimeCommittedRows',
      'getBuyAnimeImportRecovery','verifyBuyAnimeImportRecovery','importBuyAnimeInventory','resumeBuyAnimeImport',
      'readBuyAnimeRelatedRows','readBuyAnimeVersions','prepareBuyAnimeRecovery','finishBuyAnime',
      'buyAnimeRefreshPending','buyAnimeTouchedInventory','buyAnimeInventoryRows','buyAnimeCatalogPlans','buyAnimeCatalogRows',
      'recoverPendingBuyAnimeImport','completeBuyAnimeImport','ensureProductMasterFromInventory'],
    'src/providers/dataProvider.ts': ['updateProductVariantPatch', 'updateProductVariantPatchBulk',
      'getBuyAnimeImportRecovery','verifyBuyAnimeImportRecovery','importBuyAnimeInventory','resumeBuyAnimeImport',
      'recoverPendingBuyAnimeImport','completeBuyAnimeImport','ensureProductMasterFromInventory'],
    'src/providers/localProvider.ts': ['updateProductVariantPatch', 'updateProductVariantPatchBulk','ensureProductMasterFromInventory'],
  }[file];
  if (!allowedMethods) fail('unreviewed provider contract exception');
  const findClass = tree => tree.statements.find(node => ts.isClassDeclaration(node)
    && node.members.some(member => member.name?.getText(tree) === 'updateProductVariantPatch'));
  const oldClass = findClass(oldTree); const newClass = findClass(newTree);
  if (!oldClass || !newClass) fail('provider class missing');
  const members = (tree, node) => node.members.filter(member => !allowedMethods.includes(member.name?.getText(tree)))
    .map(member => canonical(tree, member));
  if (JSON.stringify(members(oldTree, oldClass)) !== JSON.stringify(members(newTree, newClass))) fail('unreviewed provider member changed');
  const approvedCatalogCall=canonical(parse('rpc.ts',`supabase.rpc(CATALOG_RPC, { p_idempotency_key: catalog.key, p_request: catalog.plan.request });`)).trim().replace(/;$/u,'');
  const approvedWacaDeltaCall=canonical(parse('rpc.ts',`supabase.rpc('erp_merge_waca_master_links', {
    p_idempotency_key: plan.key,
    p_request: { family: 'waca-master-links', expectedRevision: plan.expectedRevision, links: plan.links },
  });`)).trim().replace(/;$/u,'');
  const rpc = tree => nodes(tree).filter(ts.isCallExpression).filter(node => node.expression.getText(tree) === 'supabase.rpc')
    .map(node => canonical(tree, node)).filter(call=>call!==approvedCatalogCall && call!==approvedWacaDeltaCall);
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
  const allReviews = reviewForCandidate(git, candidate.head, baseline);
  const reviews = allReviews.filter(review => {
    try { git(['--no-replace-objects', 'merge-base', '--is-ancestor', review.reviewedHead, baseline]); }
    catch { return true; }
    return false;
  });
  const usedReviews = new Set();
  const classified = changed.map(file => {
    const before = source(baseline, file, oldSet.has(file));
    const after = source(candidate.head, file, newSet.has(file));
    // The review registry is release-control metadata, not runtime source. Its
    // immutable anchors are verified by reviewForCandidate above, but appending
    // a later exact review cannot require that append's own future commit hash.
    const reviewed = file === 'config/erp2-reviewed-change-impacts.json'
      ? null : classifyReviewedFile({ file, after, reviews });
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
  const backupFiles = [...new Set([...oldFiles, ...newFiles].filter(file =>
    /(?:durableResourceRegistry|workbenchJsonBackup|closingDateSidecarBackup|backupFormat|CloudAtomicRestore|cloudAtomicRestore)/u.test(file)))];
  const backupParity = backupFiles.every(file => {
    if (!oldSet.has(file) || !newSet.has(file)) return false;
    const before = source(baseline, file, true), after = source(candidate.head, file, true);
    if (sourceHash(before) === sourceHash(after)) return true;
    const reviewed = classifyReviewedFile({ file, after, reviews });
    if (file === 'src/components/CloudAtomicRestorePanel.tsx'
      && reviewed?.review.id === 'restore-explicit-intent-and-pending-sync-v2'
      && reviewed.row.classification === 'APPLICATION_DOMAIN_ONLY') {
      assertReviewedRestoreOrchestrationContract(file, before, after);
      return true;
    }
    if (file !== 'src/providers/cloud/cloudAtomicRestore.ts'
      || reviewed?.review.id !== 'erp1-v1-outbound-timestamp-adapter-v1'
      || reviewed.row.classification !== 'PERSISTENCE_BEHAVIOR_SCHEMA_NEUTRAL') return false;
    assertReviewedRestoreAdapterContract(file, before, after);
    return true;
  });
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
  const requiredRegressions = [...new Set([
    ...reviews.filter(review => usedReviews.has(review.id)).flatMap(review => review.requiredRegressions),
    // Permanent release contract: Restore cannot leave normal business flows
    // blocked by a previous business generation. Actual private fixtures and
    // disposable native execution are required, never synthetic PASS evidence.
    ...(allReviews.some(review => review.id === 'buyanime-post-restore-recovery-epoch-v1')
      && baseline !== candidate.head && classified.some(row => row.file.startsWith('src/'))
      ? ['erp1-v1-exact-restore', 'post-restore-business-release'] : []),
  ])];
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
