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

// ---- BEGIN restore-variant-duplicate-normalization-v1 panel contract ----
export const RESTORE_VARIANT_NORMALIZATION_REVIEW = 'restore-variant-duplicate-normalization-v1';
const RESTORE_VARIANT_NORMALIZATION_PANEL_ADDITIONS = Object.freeze([
  ["import { normalizeCloudRestoreCandidateVariants, type CloudRestoreVariantNormalizationRecord } from '../lib/cloudRestoreVariantNormalization';\n", 1],
  ['  const [variantNormalization, setVariantNormalization] = useState<CloudRestoreVariantNormalizationRecord | null>(null);\n', 1],
  ['    setVariantNormalization(null);\n', 2],
  [`      // Duplicate Variants are normalized before portability/upload; unknown conflicts stop here (nothing is sent).
      const variantStep = await normalizeCloudRestoreCandidateVariants(source);
      if (candidateGenerationRef.current !== generation) return;
      setVariantNormalization(variantStep.record);
      if (!variantStep.candidate) throw variantStep.error;
      source = variantStep.candidate;
      finishPhase('variantNormalization');
`, 1],
  [`      {variantNormalization && <div data-testid="cloud-restore-variant-normalization" style={{ marginTop: 14, padding: 12, borderRadius: 8,
        border: \`1px solid \${variantNormalization.status === 'BLOCKED' ? '#dc2626' : '#cbd5e1'}\`, fontSize: 13, overflowWrap: 'anywhere' }}>
        <strong>重複規格正規化：{variantNormalization.status === 'BLOCKED' ? '已停止（未送出任何資料）'
          : variantNormalization.status === 'NORMALIZED' ? '已整理，將以整理後資料還原' : '無重複，資料未變更'}</strong>
        <div>重複組數：{variantNormalization.duplicateSets}；合併：{variantNormalization.normalizedSets}；已核准衝突：{variantNormalization.approvedConflictsApplied}；
          軟刪除規格：{variantNormalization.softDeletedVariants}；改指向引用：{variantNormalization.repointedReferences}；軟刪除組合：{variantNormalization.softDeletedBundles}</div>
        <div>原始檔 SHA-256：<code>{variantNormalization.sourceFileSha256}</code></div>
        <div>原始資料 fingerprint：<code>{variantNormalization.sourceSnapshotFingerprint}</code></div>
        <div>正規化後 fingerprint：<code>{variantNormalization.normalizedSnapshotFingerprint ?? '（未產生）'}</code></div>
        {variantNormalization.conflicts.length > 0 && <table data-testid="cloud-restore-variant-conflicts" style={{ marginTop: 8, borderCollapse: 'collapse' }}>
          <thead><tr><th>SKU</th><th>規格</th><th>欄位</th><th>各 Variant 數值</th><th>原因</th></tr></thead>
          <tbody>{variantNormalization.conflicts.map(conflict => <tr key={\`\${conflict.setStateFingerprint}:\${conflict.field}\`}>
            <td>{conflict.key.sku}</td><td>{conflict.key.spec || '—'}</td><td>{conflict.field}</td>
            <td>{Object.entries(conflict.values).map(([id, value]) => \`\${id}=\${JSON.stringify(value)}\`).join('；')}</td><td>{conflict.reason}</td>
          </tr>)}</tbody>
        </table>}
      </div>}
`, 1],
]);
export const WACA_TRANSITION_RESTORE_REVIEW = 'waca-counted-transition-restore-v1';
const WACA_TRANSITION_PANEL_ADDITIONS = Object.freeze([
  ["import { assessWacaRestoreLoss, type WacaRestoreLossReport } from '../waca/restoreLoss';\nimport { WacaRestoreLossNotice } from './WacaRestoreLossNotice';\n", 1],
  ['  const [wacaRestoreLoss, setWacaRestoreLoss] = useState<WacaRestoreLossReport | null>(null);\n  const [wacaRestoreLossAcknowledged, setWacaRestoreLossAcknowledged] = useState(false);\n', 1],
  ['    setWacaRestoreLoss(null);\n    setWacaRestoreLossAcknowledged(false);\n', 2],
  [`      // WACA work in ERP2 that this backup lacks is shown before any write (a Restore never re-applies it).
      const wacaLossReport = assessWacaRestoreLoss(await dataProvider.getNextWacaSnapshot(), source.data);
      if (candidateGenerationRef.current !== generation) return;
      setWacaRestoreLoss(wacaLossReport);
`, 1],
  ['    if (wacaRestoreLoss?.atRisk && !wacaRestoreLossAcknowledged) return;\n', 1],
  ['          <WacaRestoreLossNotice report={wacaRestoreLoss} acknowledged={wacaRestoreLossAcknowledged} onAcknowledge={setWacaRestoreLossAcknowledged} />\n', 1],
]);
const WACA_TRANSITION_PANEL_REPLACEMENTS = Object.freeze([
  ['            下次匯入 WACA 時會建立新的接管基準，歷史數量不會因匯入不完整而自動減少。',
    '            並標記需要匯入完整 WACA 歷史訂單；匯入後會由訂單重新計算並取代舊數量。'],
]);
/** Exact review waca-counted-transition-restore-v1: only the WACA Restore pre-check additions, one
 * reworded legacy notice, and exactly one added read-only provider port (getNextWacaSnapshot). */
export function assertWacaTransitionPanelContract(previous, after) {
  if (previous === null || after === null) fail('WACA transition panel requires the exact reviewed previous source');
  let restored = after.replace(/\r\n?/gu, '\n');
  for (const [text, count] of WACA_TRANSITION_PANEL_ADDITIONS) {
    if (restored.split(text).length - 1 !== count) fail('WACA transition panel addition missing, changed or repeated');
    restored = restored.split(text).join('');
  }
  for (const [now, was] of WACA_TRANSITION_PANEL_REPLACEMENTS) {
    if (restored.split(now).length - 1 !== 1) fail('WACA transition panel replacement missing or repeated');
    restored = restored.replace(now, was);
  }
  if (restored !== previous.replace(/\r\n?/gu, '\n')) fail('restore panel changed beyond the exact WACA transition additions');
  const file = 'src/components/CloudAtomicRestorePanel.tsx';
  const ports = source => {
    const tree = parse(file, source);
    return nodes(tree).filter(ts.isCallExpression).filter(node =>
      /dataProvider\.|executeRestore|checkRestoreOutcome|prepareCloudRestore|verifyCloudRestore|refreshAuthoritative|restoreCloudDeadline/u
        .test(node.expression.getText(tree))).map(node => canonical(tree, node));
  };
  const added = ports(after).filter(port => !ports(previous).includes(port));
  if (added.length !== 1 || !added[0].includes('getNextWacaSnapshot')
    || JSON.stringify(ports(after).filter(port => port !== added[0])) !== JSON.stringify(ports(previous))) {
    fail('WACA transition panel may only add the read-only WACA snapshot port');
  }
}
export function assertRestoreVariantNormalizationPanelContract(previous, after) {
  if (previous === null || after === null) fail('restore variant normalization panel requires the exact reviewed previous source');
  let restored = after.replace(/\r\n?/gu, '\n');
  for (const [text, count] of RESTORE_VARIANT_NORMALIZATION_PANEL_ADDITIONS) {
    if (restored.split(text).length - 1 !== count) fail('restore variant normalization panel addition missing, changed or repeated');
    restored = restored.split(text).join('');
  }
  if (restored !== previous.replace(/\r\n?/gu, '\n')) fail('restore panel changed beyond the exact variant normalization additions');
}
// ---- END restore-variant-duplicate-normalization-v1 panel contract ----

export function assertReviewedRestoreOrchestrationContract(file, before, after) {
  if (before === null || after === null) fail('Restore orchestration requires an existing exact reviewed source');
  let restored = after;
  if (file === 'src/providers/cloud/cloudRestoreSubmit.ts') {
    restored = after.replace('  options: { newIntent?: boolean } = {},\n', '')
      .replace('if (existing && !options.newIntent)', 'if (existing)')
      .replace('if (identity && !options.newIntent)', 'if (identity)');
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

// ---- BEGIN restore-ops-g1 provider contract function (exact review restore-ops-g1-idle-scheduler-v1) ----
// P0-1 Phase 2 (G-1): the idle-time Restore OPS maintenance may only reach the
// database through the already-adopted bounded RPC erp_cleanup_expired_restore_ops
// with its exact argument. This is not a directory allowlist: only these two exact
// files are accepted, the immutable before/after review hashes remain mandatory,
// and any later edit of the new scheduler needs a new exact guard review.
const RESTORE_OPS_RPC = 'erp_cleanup_expired_restore_ops';
const RESTORE_OPS_FORBIDDEN_IDENTIFIERS = new Set(['supabase', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  'indexedDB', 'localStorage', 'sessionStorage', 'caches', 'importScripts', 'require', 'navigator', 'window',
  'document', 'globalThis', 'self', 'eval', 'Function', 'postMessage', 'BroadcastChannel']);
const RESTORE_OPS_SCHEDULER_STRINGS = new Set(['erp_restore_ops_maint:v1:state', 'erp_restore_ops_maint:v1:log',
  'erp_restore_ops_maint:v1:opportunity', 'erp_restore_ops_maint:v1:settings_seen_at']);
export function assertRestoreOpsMaintenanceContract(file, before, after) {
  const scheduler = file === 'src/providers/cloud/cloudRestoreOpsScheduler.ts';
  const maintenance = file === 'src/providers/cloud/cloudRestoreOpsMaintenance.ts';
  if ((!scheduler && !maintenance) || after === null) fail('unreviewed restore OPS contract exception');
  if (scheduler && before !== null) fail('restore OPS scheduler needs a new exact review');
  if (maintenance && before === null) fail('restore OPS maintenance baseline missing');
  const tree = parse(file, after);
  const all = nodes(tree);
  // No unreviewed dependency, re-export, dynamic import or global persistence/network API.
  const imports = tree.statements.filter(ts.isImportDeclaration);
  if (tree.statements.some(node => ts.isExportDeclaration(node) && node.moduleSpecifier)) fail('restore OPS re-export');
  if (all.some(node => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)) fail('restore OPS dynamic import');
  if (all.some(node => ts.isIdentifier(node) && RESTORE_OPS_FORBIDDEN_IDENTIFIERS.has(node.text))) fail('restore OPS direct persistence/network I/O');
  if (maintenance && imports.length) fail('restore OPS maintenance dependency changed');
  if (scheduler) {
    if (imports.length !== 1 || imports[0].moduleSpecifier.text !== './cloudRestoreOpsMaintenance') fail('restore OPS scheduler dependency changed');
    const bound = imports[0].importClause?.namedBindings;
    const names = bound && ts.isNamedImports(bound) ? bound.elements.map(element => element.name.text) : [];
    if (imports[0].importClause?.name || !bound || !ts.isNamedImports(bound)
      || names.some(name => !['cleanupExpiredRestoreOps', 'MaintenanceOptions', 'MaintenanceSummary'].includes(name))) {
      fail('restore OPS scheduler import contract changed');
    }
  }
  // RPC-shaped literals: maintenance holds only the adopted RPC; scheduler only its own storage keys.
  for (const node of all) {
    const text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text
      : ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.text : null;
    if (text === null || !/erp_/u.test(text)) continue;
    if (maintenance ? text !== RESTORE_OPS_RPC : !RESTORE_OPS_SCHEDULER_STRINGS.has(text)) fail('restore OPS RPC/resource contract changed');
  }
  const calls = all.filter(ts.isCallExpression);
  if (maintenance) {
    const rpcCalls = calls.filter(call => call.expression.getText(tree) === 'rpc');
    const arg = rpcCalls[0]?.arguments[1];
    const property = arg && ts.isObjectLiteralExpression(arg) && arg.properties.length === 1 ? arg.properties[0] : null;
    if (rpcCalls.length !== 1 || rpcCalls[0].arguments.length < 2 || rpcCalls[0].arguments.length > 3
      || !ts.isStringLiteral(rpcCalls[0].arguments[0]) || rpcCalls[0].arguments[0].text !== RESTORE_OPS_RPC
      || !property || !ts.isPropertyAssignment(property) || property.name.getText(tree) !== 'p_exclude_request_id'
      || property.initializer.getText(tree) !== 'currentRequestId'
      || (rpcCalls[0].arguments.length === 3 && rpcCalls[0].arguments[2].getText(tree) !== 'controller?.signal')) {
      fail('restore OPS RPC name/argument contract changed');
    }
    if (all.filter(node => ts.isIdentifier(node) && node.text === 'rpc').length !== 2) fail('restore OPS RPC handle escaped');
    const exported = tree.statements.filter(node => node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
    const exportedNames = exported.map(node => node.name?.text);
    if (exportedNames.some(name => !['cleanupExpiredRestoreOps', 'MaintenanceOutcome', 'MaintenanceOptions', 'MaintenanceSummary'].includes(name))) {
      fail('restore OPS maintenance export contract changed');
    }
    const entry = (source, name) => parse(file, source).statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name
      && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
    const current = entry(after, 'cleanupExpiredRestoreOps'), previous = entry(before, 'cleanupExpiredRestoreOps');
    const params = node => node.parameters.map(p => p.name.getText());
    if (!current || !previous || !current.modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)
      || JSON.stringify(params(previous)) !== JSON.stringify(['rpc', 'currentRequestId'])
      || JSON.stringify(params(current)) !== JSON.stringify(['rpc', 'currentRequestId', 'options'])
      || !current.parameters[2].questionToken
      || !current.body.statements.some(ts.isTryStatement) || !current.body.statements.find(ts.isTryStatement).catchClause
      || !current.body.statements.some(node => ts.isIfStatement(node) && node.expression.getText() === 'running')) {
      fail('restore OPS maintenance function contract changed');
    }
  } else {
    const run = calls.filter(call => call.expression.getText(tree) === 'cleanupExpiredRestoreOps');
    if (run.length !== 1 || run[0].arguments.length !== 3 || run[0].arguments[0].getText(tree) !== 'env.rpc'
      || run[0].arguments[1].kind !== ts.SyntaxKind.NullKeyword) fail('restore OPS scheduler RPC path changed');
    if (all.filter(node => ts.isPropertyAccessExpression(node) && node.getText(tree) === 'env.rpc').length !== 1) {
      fail('restore OPS scheduler calls the RPC handle directly');
    }
  }
}
// ---- END restore-ops-g1 provider contract function ----
// ---- BEGIN p02-1a provider contract function (exact review p02-phase1a-c1-c1a-v1 + c1d-v1) ----
// P0-2 Phase 1a (C1 + C1a): Cloud cache write fence, Realtime readiness gate and local
// sync diagnostics. The three new modules are pinned byte-for-byte and must stay free of
// imports and of any network / persistence / RPC API. The three modified provider files
// may differ from the adopted baseline only by the exact reviewed class members and
// top-level statements listed below (SHA-256 of the canonical, comment-free AST print).
// Those reviewed pieces are proven, then restored to the baseline, and the restored source
// is re-checked by every pre-existing provider rule unchanged. No wildcard, no directory
// allowlist; any later edit of a pinned piece needs a new exact guard review.
const P02_1A_NEW_MODULES = Object.freeze({
  'src/providers/cloud/cloudCacheWriteFence.ts': '484088615dc49b1b581cd23e33ba46d56c0d96732b1f215514ab9bd9b722fbcd',
  'src/providers/cloud/cloudRealtimeReadiness.ts': 'b4ca3ed711975e91a3a1358cf7a29235323412a47849452bacf10e0106f9ecef',
  'src/providers/cloud/cloudSyncObservability.ts': '66c716f21b91b2e31a4f9286ef968f970fed2f1c2a61c323f3c689d38e888201',
});
const P02_1A_FORBIDDEN_IDENTIFIERS = new Set(['supabase', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  'indexedDB', 'localStorage', 'sessionStorage', 'caches', 'importScripts', 'require', 'navigator', 'document',
  'globalThis', 'self', 'eval', 'Function', 'postMessage', 'BroadcastChannel', 'window']);
// Only the diagnostics module may expose its read-only snapshot function on window.
const P02_1A_WINDOW_ALLOWED = 'src/providers/cloud/cloudSyncObservability.ts';
// C1d (exact review p02-phase1a-c1d-v1): the readiness gate may import exactly its two
// diagnostics recorders from the pinned, I/O-checked diagnostics module above. Every other
// import, export-from, extra import or different text still fails closed.
const P02_1A_EXACT_IMPORTS = Object.freeze({
  'src/providers/cloud/cloudRealtimeReadiness.ts': "import { noteRealtimeSystemOk, recordRealtimeSystemAnomaly } from './cloudSyncObservability';",
});
const P02_1A_REVIEWED = Object.freeze({
  'src/providers/cloud/supabaseProvider.ts': { className: 'SupabaseProvider', members: {"lastCoreSnapshotReadiness":"a5401b263cecc79dc73aca0f620f47f6702c8abd943b7bcc65cf3dbbea9b7839","pullCoreProductData":"8f2104b4ed4b7482e944658956cfa9f537e19cc604abb6107e382901e23c8005","readCoreCollectionForFence":"9397ec6890c89cc9954073c19d162b52cf510b50cbbd4184a31f0687ff362bbd","awaitCoreSnapshotAfterRealtimeReady":"2925b342e544c289a966a3928a67ec59c084ecc316f7120700529c44f78a7552"}, statements: [{"before":null,"after":"18f8c491011341be2e42dbda5dc66510f60aa21149842e0c6658f2b421a0c789"},{"before":null,"after":"d922dca961661a6a9d861145cb6bee8e288b3a932a6bfaceee3b9c9bebe0dd6a"},{"before":null,"after":"f5920f3166d0bf5b4d0241554843cf1cde88befe3e56f92a1b2f2f8ca75f3030"},{"before":null,"after":"421b220be01e370262f127373775a68d1f73f42be02991da9cf6eb90f0e7ecb0"},{"before":null,"after":"1f3c3ffe9692d58336561102e1a4d586a1587b3494eeac8a8e503f0fd45b9962"},{"before":null,"after":"236bab3cd080859ec52b8090c8ada4b61b429f3bc49e6a73b8a3d7633f9a3319"},{"before":null,"after":"d6e088e40ca977cc909a384ed83b5cf9c0463ac3f4831b818a55a0e4312c609e"},{"before":null,"after":"69326d309538d0858e4dc613f31b3995faedb76ccae416bf90ea219fe59a1eda"},{"before":null,"after":"91d4e9ffa8efb4a0da1706cc354870a4905a86735d557e6fe892d8cd5eceaead"}] },
  'src/providers/cloud/cloudTargetedCache.ts': { className: 'CloudTargetedCache', members: {"resolveUnresolvedTables":"490eadfaf9ad4ec214632be17687dc97153c93b52e69f1d5bdbac9b30ea33c47","performRefresh":"adbd27d97e22eef19b70511c52959a0de7ef03c488c68e211365083fd090f28f","query":"e69960e7eca60609b5b04cc8650833c45929138e75474b3cf3105599dd872107","queryAll":"17067174bf149be43d6cfba0c38ad296c1667ea08a879412d4679b967b1516fa","refreshSince":"c905e1b7e25d70f2a1aba4801a92d4a0e69b0a7b4b0fc40fd43aefab44fe87fe","refreshAuthoritativeTables":"45e8e7985cd93b5cdcc6c44e6442f67857e78081daedf09509950f1d27d4c701","merge":"de953b94d2cda54de80e58d811e6d3db6d29d8b7cedbf9d3821c63923757f6ea"}, statements: [{"before":null,"after":"9c19d17d4342ff5b5175f32675182d5f6e37253b1261747f12f80762d982f6d0"},{"before":null,"after":"16fb54f818db2966913cfe11b8948f97b65d3139a773fccaa2a42cd3b771502d"},{"before":"a8a95e24782699f48645b260b5d59c1eb0135968048de17f12b8ceef35909741","after":"3297da5b6eb4abdf611540db2d709b0e692f38208a68529835aa1ef04f5081a3"},{"before":null,"after":"19071344004c584c1c0b873b585586ca76303d56d13c89879f8a3a21171f05b0"},{"before":null,"after":"d1bb6ca17cddde78fa08d10a7ab99014d31a1eab04024fba850442b0b4d68ae3"},{"before":null,"after":"479c388ed05a1042c0dbc03a3d7447406a619269089e4da1098d3bcb5d71ba09"},{"before":null,"after":"76a0735d30d5ff2e07c2602d5e765d8c3a03242734ca3fc5d42026b17ad21fb9"},{"before":null,"after":"64c8602bbbb5b99867e0f677a95d996f89dc3b42250305d280e738cfbb200b8e"}] },
  'src/providers/dataProvider.ts': { className: 'DynamicDataProvider', members: {"awaitCoreSnapshotAfterRealtimeReady":"0a5a900f294ba933e8db87f78d01751f7ed4d78bdb90c612ffaa2d3869d911ad"}, statements: [] },
  // No class and no pre-existing provider rule: only the pinned statements may differ.
  'src/providers/cloud/cloudConnectivity.ts': { className: null, members: {}, statements: [{"before":null,"after":"77ecc0d3aed3f0d1c242a2ed791a3f591dadb21834660d54cdb51f4c2e800b19"},{"before":null,"after":"221eccee05cb1759a363f1530483a9402f0deef836bbb28b929da693de2a1338"},{"before":null,"after":"a9954312b46060efd5f9e5b3285c84a635c1db9d77cd77c758fd05de74074c8b"},{"before":null,"after":"220c0abb74fa6418b5c1216e4cfe49051c8307e9d93e6e374981407c24969d1c"},{"before":"fe6f3ed990dc5d7cb007cc95f9927231803ac752059384164cb7d38caf4fb08d","after":"e24ba2655498b0966defbfc2ae4fdfb92cec74c07ee5c681ed5c8ee75dff7146"},{"before":"797f4280d64a0352e28ebee4e5849d4702c08dca43a8261e8d8acff9f3af79f4","after":"9f77f3356ce72aabe5fa03fe72393208f6a7a9937b7662074d4705d6f9257143"},{"before":"d727a9451e0ec4397cab4b93ba7f19bf6fa84d790b8ca9c95ae439fac1592eb5","after":"ab4980fbc838d0424fa4207f627b9245efd7aa4b20c04510cc761b9173ba3751"},{"before":"0a7f7a2ba737759d631dd2a4ce750788deee5f344598a03b0234181b3f778a87","after":"485c1ad1df5fa9b0ec618d275b111ae44f7b30ae2f20fb234d79e2a7cae0534d"},{"before":"225a023252734a7079962f626cd49f8cd9e8052062cf2850319167843c7858ef","after":"4cf9ae8ce5bfa5c79db2c48041d05d2da673a9f4b0d1aa912b2b7b0fcd9e735e"},{"before":"c0dd6e421c9b5e7549cb9ee5bfcab52c43d4c824d14539f97bdd7c0797f3877b","after":"43219b389e8100e709a7eac7f742ba211699dbd244fb28c1f87e52ff274f68bb"},{"before":null,"after":"4e318f37c3e18f58beaa32e78723fdbdad20815185c885b170574162af559492"},{"before":null,"after":"218f7090eac4a4c2d89512e249759f32d599321fd2aa3a656a53ee56ef49b41b"},{"before":null,"after":"aa0a359ddd26421ad3ca4a44021074c76895e1fc2b7db20c771064416e001bcd"}] },
});
// The pre-existing cloudTargetedCache rule normalizes one reviewed line (review
// buyanime-simple-flow-performance-v1, e7185e8b) back to its pre-review form. The adopted
// baseline 5f73b2b0 already contains that reviewed line, so the rule rejects every source,
// even an unchanged one. For a p02-reviewed source only, the baseline is given the same
// normalization when BOTH sides still contain the adopted line; a revert of it still fails.
const P02_CACHE_ADOPTED_LINE = "if (isAuthoritativeResourceRead || (previousStatus !== 'fresh-online' && previousStatus !== 'fresh-empty'))";
const P02_CACHE_LEGACY_LINE = "if ((!this.protectsDraft && !this.prepareDraftProtection) || (previousStatus !== 'fresh-online' && previousStatus !== 'fresh-empty'))";
let p02RestoringReviewedSource = false;
const p02Hash = (tree, node) => hash(canonical(tree, node));
const p02MemberKey = (tree, member) => member.name ? member.name.getText(tree) : `#${ts.SyntaxKind[member.kind]}`;
// The exact review applies only to sources that actually contain a reviewed p02 piece;
// every other comparison of these files (e.g. earlier exact reviews) keeps the
// pre-existing rules untouched.
export function p02Phase1aReviewApplies(file, after) {
  if (Object.hasOwn(P02_1A_NEW_MODULES, file)) return true;
  const review = P02_1A_REVIEWED[file];
  if (!review || after === null) return false;
  let tree;
  try { tree = parse(file, after); } catch { return false; }
  const pinnedStatements = new Set(review.statements.map(entry => entry.after));
  const pinnedMembers = new Set(Object.values(review.members));
  if (tree.statements.some(node => pinnedStatements.has(p02Hash(tree, node)))) return true;
  if (!review.className) return false;
  const cls = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === review.className);
  return Boolean(cls?.members.some(member => pinnedMembers.has(p02Hash(tree, member))));
}
export function assertP02Phase1aProviderContract(file, before, after) {
  if (after === null) fail('p02 1a provider source missing');
  const pinned = P02_1A_NEW_MODULES[file];
  if (pinned) {
    if (before !== null) fail('p02 1a module needs a new exact review');
    if (hash(after) !== pinned) fail('p02 1a module differs from its exact review');
    const tree = parse(file, after);
    const all = nodes(tree);
    const dependencies = tree.statements.filter(node => ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)
      || (ts.isExportDeclaration(node) && node.moduleSpecifier));
    const exactImport = P02_1A_EXACT_IMPORTS[file];
    if (dependencies.length > (exactImport ? 1 : 0)) fail('p02 1a module dependency changed');
    if (dependencies.length === 1 && !(ts.isImportDeclaration(dependencies[0]) && dependencies[0].getText(tree) === exactImport)) {
      fail('p02 1a module dependency changed');
    }
    if (all.some(node => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)) fail('p02 1a module dynamic import');
    for (const node of all.filter(ts.isIdentifier)) {
      if (!P02_1A_FORBIDDEN_IDENTIFIERS.has(node.text)) continue;
      if (node.text === 'window' && file === P02_1A_WINDOW_ALLOWED) continue;
      fail('p02 1a module contains network/persistence I/O');
    }
    for (const node of all) {
      const text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
        || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.text : null;
      if (text !== null && /(?:^|[^A-Za-z])(?:erp_|rpc|rest\/v1|realtime\/v1)/u.test(text)) fail('p02 1a module contains a resource/RPC literal');
    }
    return;
  }
  const review = P02_1A_REVIEWED[file];
  if (!review || before === null) fail('unreviewed p02 1a provider exception');
  const oldTree = parse(file, before); const newTree = parse(file, after);
  const findClass = tree => review.className ? tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === review.className) : null;
  const oldClass = findClass(oldTree); const newClass = findClass(newTree);
  if (review.className && (!oldClass || !newClass)) fail('p02 1a provider class missing');
  const edits = [];
  const oldMembers = new Map((oldClass?.members ?? []).map(member => [p02MemberKey(oldTree, member), member]));
  const seen = new Set();
  for (const member of newClass?.members ?? []) {
    const key = p02MemberKey(newTree, member);
    if (!Object.hasOwn(review.members, key)) continue;
    if (seen.has(key)) fail('p02 1a duplicate reviewed member');
    seen.add(key);
    const previous = oldMembers.get(key);
    if (previous && p02Hash(oldTree, previous) === p02Hash(newTree, member)) continue;
    if (p02Hash(newTree, member) !== review.members[key]) fail(`p02 1a reviewed member drifted: ${key}`);
    edits.push({ start: member.getStart(newTree), end: member.end, text: previous ? before.slice(previous.getStart(oldTree), previous.end) : '' });
  }
  const oldStatements = new Set(oldTree.statements.filter(node => node !== oldClass).map(node => p02Hash(oldTree, node)));
  const replaced = new Map(review.statements.filter(entry => entry.before).map(entry => [entry.after, entry.before]));
  const added = new Set(review.statements.filter(entry => !entry.before).map(entry => entry.after));
  const oldByHash = new Map(oldTree.statements.filter(node => node !== oldClass).map(node => [p02Hash(oldTree, node), node]));
  const consumedOld = new Set();
  for (const statement of newTree.statements) {
    if (statement === newClass) continue;
    const digest = p02Hash(newTree, statement);
    if (oldStatements.has(digest)) { consumedOld.add(digest); continue; }
    if (replaced.has(digest)) {
      const previous = oldByHash.get(replaced.get(digest));
      if (!previous) fail('p02 1a reviewed statement baseline missing');
      consumedOld.add(replaced.get(digest));
      edits.push({ start: statement.getStart(newTree), end: statement.end, text: before.slice(previous.getStart(oldTree), previous.end) });
      continue;
    }
    if (added.has(digest)) { edits.push({ start: statement.getStart(newTree), end: statement.end, text: '' }); continue; }
    fail('p02 1a unreviewed top-level statement');
  }
  if ([...oldStatements].some(digest => !consumedOld.has(digest))) fail('p02 1a baseline top-level statement removed');
  // Reviewed provider code may read only; it never writes through Supabase or calls an RPC.
  for (const call of nodes(newTree).filter(ts.isCallExpression)) {
    const name = call.expression.getText(newTree);
    if (/\.(?:insert|update|upsert|delete)$/u.test(name) && /supabase|query/u.test(name)) {
      if (edits.some(edit => call.getStart(newTree) >= edit.start && call.end <= edit.end)) fail('p02 1a reviewed code writes to Cloud');
    }
    if (name === 'supabase.rpc' && edits.some(edit => call.getStart(newTree) >= edit.start && call.end <= edit.end)) fail('p02 1a reviewed code calls an RPC');
  }
  let restored = after;
  for (const edit of edits.sort((a, b) => b.start - a.start)) restored = restored.slice(0, edit.start) + edit.text + restored.slice(edit.end);
  if (!review.className) {
    // No pre-existing rule covers this file: after removing the reviewed pieces it must be the baseline.
    if (canonical(parse(file, restored)) !== canonical(oldTree)) fail('p02 1a unreviewed change outside the pinned statements');
    return;
  }
  const beforeForRules = file === 'src/providers/cloud/cloudTargetedCache.ts'
    && before.includes(P02_CACHE_ADOPTED_LINE) && restored.includes(P02_CACHE_ADOPTED_LINE)
    ? before.replace(P02_CACHE_ADOPTED_LINE, P02_CACHE_LEGACY_LINE) : before;
  p02RestoringReviewedSource = true;
  try { assertReviewedProviderContract(file, beforeForRules, restored); }
  finally { p02RestoringReviewedSource = false; }
}
// ---- END p02-1a provider contract function ----
// ---- BEGIN waca-counted-transition-provider-v1 (exact review) ----
// WACA transition import (C17 / Migration 073): the two provider files may differ from their previous source only by
// the exact reviewed pieces below (SHA-256 of the canonical, comment-free AST print): one type-only import per file,
// the new counted-commit / Restore-epoch members and the one-line refusal of the legacy WACA auto-quantity write.
// Every piece is checked by hash AND by explicit fail-closed rules (single approved RPC, epoch read is read-only,
// legacy auto-quantity write refused, cloud write permission + write fence kept), then restored to its previous form
// and the restored source is judged by every pre-existing provider rule (incl. p02 1a) unchanged. No wildcard.
export const WACA_COUNTED_PROVIDER_REVIEW = 'waca-counted-transition-provider-v1';
const WACA_COUNTED_RPC = 'erp_commit_waca_counted_snapshot';
const WACA_COUNTED_PROVIDER_PIECES = Object.freeze({
  'src/providers/cloud/supabaseProvider.ts': { className: 'SupabaseProvider',
    statements: ['6126b9a509026974a121b0d4e88272e589ba350c113b6afdfdfecf86e0dd03a0'],
    members: { commitWacaCountedSnapshot: { after: '68cee09982e00e24092140a6d081b9756057ee5db07e25dd59f524c7372021eb', before: null }, readWacaRestoreEpoch: { after: '27acb67a1a87cbe2682f6a189c6be7499bc58480f1de593efb9f225c873b9886', before: null } } },
  'src/providers/dataProvider.ts': { className: 'DynamicDataProvider',
    statements: ['8334e14d4f54ee9be1192b1aa533f4c32ddb19f4653f330af1629a931bae088d'],
    members: { commitNextWacaSnapshot: { after: '60c7959897daf812eba14d771897e4506876d95c3049ec8c005c67103020f514', before: '53fc382e8790ac7f31184d833b4ac40fe642e07e981c310b82eda1029b5e2be2' }, supportsWacaCountedImport: { after: 'b01386d2f6088f20c46142177299194657189758368b6f01b773ad1c0ec31c16', before: null },
      readWacaRestoreEpoch: { after: '96b2e724b0d9462dae9e6a0f37e7d7d19ae605ceec9e4901346a8baf7c9e9163', before: null }, commitWacaCountedSnapshot: { after: '6a2f18076d7b104eff9ad50bb923b73e82dfbc60464ff1d8282e971069073bcf', before: null } } },
});
const WACA_COUNTED_NEW_MEMBERS = new Set(['commitWacaCountedSnapshot', 'readWacaRestoreEpoch', 'supportsWacaCountedImport']);
let wacaCountedRestoringReviewedSource = false;
const wacaPieceHash = (tree, node) => hash(canonical(tree, node));
const wacaClass = (tree, name) => tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name);
const wacaMemberName = (tree, member) => member.name ? member.name.getText(tree) : `#${ts.SyntaxKind[member.kind]}`;
export function wacaCountedProviderReviewApplies(file, after) {
  const review = WACA_COUNTED_PROVIDER_PIECES[file];
  if (!review || after === null) return false;
  let tree;
  try { tree = parse(file, after); } catch { return false; }
  if (tree.statements.some(node => review.statements.includes(wacaPieceHash(tree, node)))) return true;
  const cls = wacaClass(tree, review.className);
  return Boolean(cls?.members.some(member => WACA_COUNTED_NEW_MEMBERS.has(wacaMemberName(tree, member))));
}
function assertWacaCountedPieceRules(file, tree, name, member) {
  const calls = nodes(tree).filter(ts.isCallExpression).filter(call => call.getStart(tree) >= member.getStart(tree) && call.end <= member.end);
  const callee = call => call.expression.getText(tree);
  if (calls.some(call => /\.(?:insert|update|upsert|delete)$/u.test(callee(call)))) fail(`waca counted reviewed code writes to Cloud directly: ${name}`);
  const rpcs = calls.filter(call => /(?:^|\.)rpc$/u.test(callee(call)));
  const approvedRpc = file === 'src/providers/cloud/supabaseProvider.ts' && name === 'commitWacaCountedSnapshot';
  if (!approvedRpc && rpcs.length) fail(`waca counted reviewed code calls an RPC: ${name}`);
  if (approvedRpc && (rpcs.length !== 1 || callee(rpcs[0]) !== 'supabase.rpc' || !ts.isStringLiteral(rpcs[0].arguments[0])
    || rpcs[0].arguments[0].text !== WACA_COUNTED_RPC)) fail(`waca counted write may call only ${WACA_COUNTED_RPC}`);
  const text = canonical(tree, member);
  if (file === 'src/providers/cloud/supabaseProvider.ts' && name === 'commitWacaCountedSnapshot'
    && !text.includes('await this.requireCloudWritePermission();')) fail('waca counted write lost the cloud write permission check');
  if (file === 'src/providers/cloud/supabaseProvider.ts' && name === 'readWacaRestoreEpoch') {
    const froms = calls.filter(call => callee(call) === 'supabase.from');
    if (froms.length !== 1 || !ts.isStringLiteral(froms[0].arguments[0]) || froms[0].arguments[0].text !== 'erp_cloud_restore_epoch'
      || !calls.some(call => /\.select$/u.test(callee(call)))) fail('waca restore epoch read is not the exact read-only epoch select');
  }
  if (file === 'src/providers/dataProvider.ts' && name === 'commitWacaCountedSnapshot'
    && !text.includes('this.guardedWrite(() => this.supabaseProvider.commitWacaCountedSnapshot(')) fail('waca counted write bypasses the guarded write fence');
  if (file === 'src/providers/dataProvider.ts' && name === 'commitNextWacaSnapshot'
    && !nodes(tree).filter(ts.isIfStatement).some(node => node.getStart(tree) >= member.getStart(tree) && node.end <= member.end
      && node.expression.getText(tree) === 'updateAutoQuantity' && ts.isThrowStatement(node.thenStatement)
      && node.thenStatement.getText(tree) === "throw new Error('WACA_LEGACY_QUANTITY_COMMIT_DISABLED');")) {
    fail('waca legacy auto-quantity write is not refused');
  }
}
export function assertWacaCountedProviderContract(file, before, after) {
  const review = WACA_COUNTED_PROVIDER_PIECES[file];
  if (!review || before === null || after === null) fail('unreviewed waca counted provider exception');
  const oldTree = parse(file, before); const newTree = parse(file, after);
  const oldClass = wacaClass(oldTree, review.className); const newClass = wacaClass(newTree, review.className);
  if (!oldClass || !newClass) fail('waca counted provider class missing');
  const edits = [];
  for (const [name, pin] of Object.entries(review.members)) {
    const now = newClass.members.filter(member => wacaMemberName(newTree, member) === name);
    const was = oldClass.members.filter(member => wacaMemberName(oldTree, member) === name);
    if (now.length !== 1) fail(`waca counted reviewed member missing or duplicated: ${name}`);
    if (wacaPieceHash(newTree, now[0]) !== pin.after) fail(`waca counted reviewed member drifted: ${name}`);
    if (pin.before === null ? was.length !== 0 : (was.length !== 1 || wacaPieceHash(oldTree, was[0]) !== pin.before)) {
      fail(`waca counted reviewed member previous source mismatch: ${name}`);
    }
    assertWacaCountedPieceRules(file, newTree, name, now[0]);
    edits.push({ start: now[0].getStart(newTree), end: now[0].end, text: pin.before === null ? '' : before.slice(was[0].getStart(oldTree), was[0].end) });
  }
  for (const pin of review.statements) {
    const now = newTree.statements.filter(node => wacaPieceHash(newTree, node) === pin);
    if (now.length !== 1 || oldTree.statements.some(node => wacaPieceHash(oldTree, node) === pin)) fail('waca counted reviewed import missing or duplicated');
    if (!ts.isImportDeclaration(now[0]) || !now[0].importClause?.isTypeOnly) fail('waca counted reviewed import is not type-only');
    edits.push({ start: now[0].getStart(newTree), end: now[0].end, text: '' });
  }
  let restored = after;
  for (const edit of edits.sort((a, b) => b.start - a.start)) restored = restored.slice(0, edit.start) + edit.text + restored.slice(edit.end);
  wacaCountedRestoringReviewedSource = true;
  try { assertReviewedProviderContract(file, before, restored); }
  finally { wacaCountedRestoringReviewedSource = false; }
}
// ---- END waca-counted-transition-provider-v1 ----

// ---- BEGIN p02-1a realtime context contract function (exact review p02-phase1a-c1f-guard-v1) ----
// P0-2 Phase 1a C1f (M-2): Realtime completeness / Fresh / write-fence contract of the sync
// boundary. Three files are covered; any difference from the adopted baseline must match the
// exact reviewed pieces below (SHA-256 of the canonical, comment-free AST print):
//  * CloudRealtimeSyncContext.tsx - protected imports (resolved by path), the reviewed module
//    constants, the sync engine effect (subscribe, readiness proof, completeness hold
//    create/release, catch-up, epoch barrier, C1f recovery), the boundary statements that feed
//    the presentation, the Provider value and the global sync banner element. Every protected
//    identifier (hold/release, readiness, epoch barrier, recovery, presentation, ...) may occur
//    only inside those pinned pieces; the rest of the component (other rendering, refresh,
//    editing registration) may change without a new review as long as it never touches them.
//  * globalSyncPresentation.ts - every runtime top-level statement pinned (type declarations
//    free), plus an executable invariant over the full state domain: nothing that is not a Fresh
//    server read is ever presented as synced or writable.
//  * realtimeRecoveryPolicy.ts - pinned whole, import-free and I/O-free.
// On every inspection (whether or not these files changed), no other src file may name
// holdCloudFresh / releaseCloudFresh, re-export the connectivity module, or import it as a
// namespace / dynamically. LIMIT: pins prove the reviewed code is unchanged and the containment
// rules are syntactic; they are not a general control-flow proof, and arbitrary text rendered
// elsewhere in the UI cannot be excluded syntactically (only the pinned banner/presentation).
const P02_CTX_CONTEXT = 'src/contexts/CloudRealtimeSyncContext.tsx';
const P02_CTX_PRESENTATION = 'src/contexts/globalSyncPresentation.ts';
const P02_CTX_POLICY = 'src/contexts/realtimeRecoveryPolicy.ts';
export const P02_REALTIME_CONTEXT_FILES = Object.freeze([P02_CTX_CONTEXT, P02_CTX_PRESENTATION, P02_CTX_POLICY]);
const P02_CTX_PROTECTED_MODULES = new Set(['src/providers/cloud/cloudConnectivity', 'src/providers/cloud/cloudRealtimeReadiness',
  'src/providers/cloud/cloudCacheWriteFence', 'src/providers/cloud/cloudTargetedCache', 'src/contexts/globalSyncPresentation',
  'src/contexts/realtimeRecoveryPolicy', 'src/contexts/cloudRealtimeTestBridge']);
const P02_CTX_PROTECTED_BASENAMES = new Set([...P02_CTX_PROTECTED_MODULES].map(path => path.split('/').at(-1)));
// Specifiers are resolved against src/contexts (any spelling of a protected module counts); a
// non-relative specifier naming a protected module is treated as protected too (fail closed).
const p02CtxResolve = specifier => {
  if (!specifier.startsWith('.')) return specifier;
  const parts = ['src', 'contexts'];
  for (const segment of specifier.split('/')) { if (segment === '..') parts.pop(); else if (segment && segment !== '.') parts.push(segment); }
  return parts.join('/').replace(/\.(?:tsx?|jsx?|mjs)$/u, '');
};
const p02CtxProtectedImport = node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
  && (P02_CTX_PROTECTED_MODULES.has(p02CtxResolve(node.moduleSpecifier.text))
    || P02_CTX_PROTECTED_BASENAMES.has(node.moduleSpecifier.text.split('/').at(-1).replace(/\.(?:tsx?|jsx?|mjs)$/u, '')));
const P02_CTX_PROTECTED_IDS = new Set(['holdCloudFresh', 'releaseCloudFresh', 'markCloudReadFresh', 'markCloudResyncPending', 'markCloudReconnectPending',
  'markCloudReachable', 'markCloudUnavailable', 'raiseCloudCacheEpochBarrier', 'markAllCloudTablesUnresolved', 'isRealtimeReadyGeneration',
  'armRealtimeReadiness', 'disarmRealtimeReadiness', 'markRealtimeSubscribed', 'markRealtimeSystemMessage', 'markRealtimeUnavailable',
  'awaitRealtimeReadiness', 'getRealtimeReadiness', 'COMPLETENESS_HOLD', 'REALTIME_RECOVERY_POLICY', 'RealtimeRecoveryScheduler',
  'setRealtimeUnproven', 'getCloudRealtimeTestBridge', 'resolveGlobalSyncPresentation', 'assertCloudWriteAllowed', 'CloudTargetedCache',
  'syncPresentation', 'realtimeRecovery', 'setRealtimeRecovery', 'GLOBAL_SYNC_LABELS', 'REALTIME_UNPROVEN_LABEL', 'REALTIME_UNPROVEN_BANNER']);
const P02_CTX_PINS = Object.freeze({"context":{"imports":["04c6792773cc27642dcf85b3d48bf9634fb82eee309c9888baf63ddf332fe15d","0c2b82e5ba99a3b13388fdc0b8fc3dd9017f028504aa6f41453691c175437b7e","1ded6982167408ef37f37f6f6a6239f2fc3339493f9d4193de2cc041bfd5065c","75cfac80bb922f7ac35779f657b327a61526d3e2fb9451c7b01c25be93fa90d4","77ecef6e7ecfe1015d42f76b59c03559910eea2c1d09fea873d031902e103a1a","7f394f63b1b9fe96e03ae80557d61a2e3dc47b3fec384ca6700e4935eac520c5","af91826ce04dc6e3f1b9465028c80400fd82d59c49ccd5c57b448ab71103f271","b2b0016943289a1974985ab16249b1c2c835612faae5a3a7912be17dac948e89","dd4c88a1f308105f9c9d652842643a5272120ed46e80b6b63cc7a06604aae9f9"],"topLevel":{"CloudRealtimeContext":"9a71e2d1d3ae854f8752ab703cfbc65daf88440b9d7ce26ec6cfd53707d3c865","REALTIME_TABLES":"fac9776f601dfaa98be91dc1791e58d3265e8659f8e580de23a61a1a3c9d945d","GLOBAL_REFRESH_RESOURCES":"4050892699a91b6f84de1c63e684cd4c3cef0e05820acfec7daff7056a48277c","CLOUD_RESTORE_EPOCH_TABLE":"2b125e4e8e8f2b30f962c56ec454ea308cce5809e2ed2bd32f72f5f4ceb80d0a","REALTIME_READINESS_WAIT_MS":"72383b6bd57ecae07494de2575f46b79fad81d0f590e6b9e81dcbc591580f533","UNPROVEN_CATCH_UP_MS":"a84e772e77671399dbf23856995b05a10ac3daf506ff0eb5cbe3ccaafa854351","LATE_READINESS_WATCH_MS":"50f485ad7f98cd9e7fa3312086ac459e2253da3d7044c3d004b385894bcbf041","MAX_PROOF_REREADS":"6601a412be63df8f8569a9285f7d91c4a99623130af71caac0be6c71d44e44ad","COMPLETENESS_HOLD":"7e9431a57ab3f649278f923c3a19e41f66fe9649e2aa0a844142d209b49be021","useGlobalSyncControl":"45384bc8518a77182bc01d75b2d16437876015413ad5a5e74ea1b265f5a83520"},"syncEngine":"0024b2c29828b820cbd0a5ec6c9a9b75bd9499286305a9bd597cf14c31ae6629","boundaryStatements":{"testBridge":"fa56720b9483f1012f505ed3de601d10ffb176f65f8080788dcfe9e215eb6908","enabled":"0e27efc350150515a9e94edd71be02c641caf535e67fb752dada7320b536b4d5","connectivity":"02d36ae33c3a421bdcca283ab5e1a54a57afbaf705024fb83cc525e34f68cd34","cloudMode":"ac507e3f32aff0295e0d7e01e53c2a58e8430bca0be943407acbfa11c6c1600f","presentationMode":"39fe9a362867486a61dd91378235f54bad45842346880a115c857956681b4c09","presentationRefresh":"84f2d7704f8bc4a9321cf72d5419a34cbb79dd5b6a9b95553b696f1c986edb89","syncPresentation":"9338d5e11611d612a1b9a67cf3457dbb623d2b840740c83db3053eb9b13f2dc8","realtimeUnproven,setRealtimeUnproven":"a987d8cbdea2dbead391a35e6540d54142fd7e519537fe3fb274249897fa35ab","realtimeRecovery,setRealtimeRecovery":"8a32117a8651367cc596f580f8dabe41556c1a1369c3ac3f4939fc428b69cb4e","value":"7b7360b1e4923e7d87c1c75cddc3ce7f260c9af02f32177be0fb6f21982b6f26"},"banner":"26fec02e4bef842eb0a1c7714dbf4aea0f325dd1f36d633fc17a63d897e9d43c"},"presentation":{"GLOBAL_SYNC_LABELS":"ab55bb27287d13d6f0bc663a80b66e4ae34b8b6832a97bbd4787974eb8e978a8","REALTIME_UNPROVEN_LABEL":"21688fdeff0eaa83882fffde26d7b9024947775f39dac56f2f94569de84a6360","REALTIME_UNPROVEN_BANNER":"f0c20b1f02dabb1e25ed88dc35b042d6f6456a2b3a96aa9fb41183510bf1f745","isRealtimeUnproven":"20c8b4b852179dc76d35ccd6ac358de576851c24ddc77d5ab4d10cde3b1cb06b","realtimeUnprovenView":"b99422800dbc29ce1aa7756cf340e49306a2f2a76a0df027b2673c22636197e3","resolveGlobalSyncPresentation":"2926c9de43206055c87f90325bf56f722dfdf77a0050bc266db66347e2b89a2a","resolveGlobalSyncStatus":"9a95111153b23f74222ad4a1a49e8bc64c429de9ba8c2d18f6a5ab3cc0d668e5"},"policy":"672ba9b2e44c29b0ed6a5a9dcdf0b772595ec4ed212b6284b6a65f499dedd3fb"});
const p02CtxBindingNames = (tree, statement) => {
  if (ts.isVariableStatement(statement)) {
    const names = [];
    const visit = name => { if (ts.isIdentifier(name)) names.push(name.text); else name.elements?.forEach(element => { if (!ts.isOmittedExpression(element)) visit(element.name); }); };
    statement.declarationList.declarations.forEach(declaration => visit(declaration.name));
    return names.join(',');
  }
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) return statement.name.text;
  if (ts.isImportDeclaration(statement)) return `import:${statement.moduleSpecifier.text}`;
  return `#${ts.SyntaxKind[statement.kind]}:${p02Hash(tree, statement).slice(0, 12)}`;
};
const p02CtxBanners = tree => nodes(tree).filter(node => ts.isJsxAttribute(node) && node.name.getText(tree) === 'data-global-sync-banner').map(attribute => {
  let node = attribute.parent;
  while (node && !ts.isJsxExpression(node)) node = node.parent;
  return node ?? attribute;
});
const p02CtxIsSyncEngine = (tree, statement) => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
  && statement.expression.expression.getText(tree) === 'useEffect'
  && nodes(statement).some(node => ts.isNewExpression(node) && node.expression.getText(tree) === 'CloudTargetedCache');
/** Current digests of the reviewed pieces (used to build and review the pins). */
export function p02RealtimeContextDigests(file, after) {
  const tree = parse(file, after);
  if (file === P02_CTX_POLICY) return { module: p02Hash(tree, tree) };
  if (file === P02_CTX_PRESENTATION) {
    const runtime = tree.statements.filter(node => !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)
      && !(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly));
    return { statements: Object.fromEntries(runtime.map(node => [p02CtxBindingNames(tree, node), p02Hash(tree, node)])) };
  }
  if (file !== P02_CTX_CONTEXT) fail('p02 1a realtime context: unknown file');
  const imports = tree.statements.filter(p02CtxProtectedImport);
  const boundary = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'CloudRealtimeSyncBoundary');
  const body = boundary.length === 1 ? boundary[0].body.statements : [];
  const engines = body.filter(node => p02CtxIsSyncEngine(tree, node));
  return {
    imports: imports.map(node => p02Hash(tree, node)).sort(),
    topLevel: Object.fromEntries(tree.statements.filter(node => ts.isVariableStatement(node) || (ts.isFunctionDeclaration(node) && node.name?.text !== 'CloudRealtimeSyncBoundary'))
      .map(node => [p02CtxBindingNames(tree, node), p02Hash(tree, node)])),
    boundaryCount: boundary.length,
    syncEngines: engines.map(node => p02Hash(tree, node)),
    boundaryStatements: Object.fromEntries(body.filter(ts.isVariableStatement).map(node => [p02CtxBindingNames(tree, node), p02Hash(tree, node)])),
    banners: p02CtxBanners(tree).map(node => p02Hash(tree, node)),
  };
}
const p02PresentationSemantics = (file, after) => {
  // Executes only the exact reviewed source (the pins were verified first). Type-only module.
  const js = ts.transpileModule(after, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: file }).outputText;
  if (/\brequire\s*\(|\bimport\s*\(/u.test(js)) fail('p02 1a presentation gained a runtime dependency');
  const exports = {};
  new Function('exports', js)(exports);
  const reads = ['loading', 'fresh-online', 'fresh-empty', 'stale-cache', 'read-error', 'offline'];
  const reasons = [null, 'realtime-readiness-pending', 'realtime-system-ok-missing', 'realtime-channel_error', 'realtime-recovering-manual', 'cloud-read-failed', 'reconnect-pending'];
  for (const status of ['checking', 'online', 'offline']) for (const readStatus of reads) for (const reason of reasons)
    for (const pending of [false, true]) for (const busy of [false, true]) for (const errorAt of [null, 5]) for (const restorePending of [false, true])
      for (const realtime of [undefined, { unproven: false }, { unproven: true }]) {
        const view = exports.resolveGlobalSyncPresentation('cloud', { status, readStatus, authoritativeReadPending: pending, lastReachableAt: 1, lastFreshReadAt: 1, reason },
          { mode: 'cloud', busy, errorAt, lastCompletedAt: null, message: '', restorePending }, realtime);
        const isFresh = readStatus === 'fresh-online' || readStatus === 'fresh-empty';
        if (!isFresh && (view.status === 'fresh' || view.writeAllowed !== false || view.tone === 'success' || view.label === exports.GLOBAL_SYNC_LABELS.fresh)) {
          fail('p02 1a presentation shows an unproven state as synced or writable');
        }
        if (!isFresh && realtime?.unproven && !restorePending && view.action !== 'realtime-reconnect') fail('p02 1a presentation hides the unproven read-only state');
      }
};
export function assertP02RealtimeContextContract(file, after) {
  if (after === null) fail('p02 1a realtime context source missing');
  const tree = parse(file, after);
  const all = nodes(tree);
  if (all.some(node => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)) fail('p02 1a realtime context dynamic import');
  const current = p02RealtimeContextDigests(file, after);
  if (file === P02_CTX_POLICY) {
    if (tree.statements.some(node => ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier))) {
      fail('p02 1a recovery policy dependency changed');
    }
    for (const node of all.filter(ts.isIdentifier)) if (P02_1A_FORBIDDEN_IDENTIFIERS.has(node.text)) fail('p02 1a recovery policy contains network/persistence I/O');
    if (current.module !== P02_CTX_PINS.policy) fail('p02 1a recovery policy differs from its exact review');
    return;
  }
  if (file === P02_CTX_PRESENTATION) {
    if (tree.statements.some(node => ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)) fail('p02 1a presentation runtime import');
    const expected = P02_CTX_PINS.presentation;
    const names = Object.keys(current.statements);
    if (names.length !== Object.keys(expected).length || names.some(name => !Object.hasOwn(expected, name))) fail('p02 1a presentation unreviewed top-level statement');
    for (const name of names) if (current.statements[name] !== expected[name]) fail(`p02 1a presentation statement drifted: ${name}`);
    p02PresentationSemantics(file, after);
    return;
  }
  const pins = P02_CTX_PINS.context;
  if (JSON.stringify(current.imports) !== JSON.stringify([...pins.imports].sort())) fail('p02 1a realtime context protected import changed');
  for (const node of tree.statements.filter(ts.isImportDeclaration)) {
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && p02CtxProtectedImport(node)) fail('p02 1a realtime context namespace import');
  }
  for (const [name, digest] of Object.entries(pins.topLevel)) if (current.topLevel[name] !== digest) fail(`p02 1a realtime context top-level statement drifted: ${name}`);
  if (current.boundaryCount !== 1) fail('p02 1a realtime boundary missing or duplicated');
  if (current.syncEngines.length !== 1 || current.syncEngines[0] !== pins.syncEngine) fail('p02 1a realtime sync engine drifted');
  for (const [name, digest] of Object.entries(pins.boundaryStatements)) if (current.boundaryStatements[name] !== digest) fail(`p02 1a realtime boundary statement drifted: ${name}`);
  if (current.banners.length !== 1 || current.banners[0] !== pins.banner) fail('p02 1a realtime global sync banner drifted');
  // Containment: protected identifiers only inside the pinned pieces.
  const boundary = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'CloudRealtimeSyncBoundary');
  const pinnedTopLevel = new Set(Object.keys(pins.topLevel));
  const pinnedBoundary = new Set(Object.keys(pins.boundaryStatements));
  const ranges = [
    ...tree.statements.filter(p02CtxProtectedImport),
    ...p02CtxBanners(tree),
    ...tree.statements.filter(node => (ts.isVariableStatement(node) || ts.isFunctionDeclaration(node)) && pinnedTopLevel.has(p02CtxBindingNames(tree, node))),
    ...boundary.body.statements.filter(node => p02CtxIsSyncEngine(tree, node) || (ts.isVariableStatement(node) && pinnedBoundary.has(p02CtxBindingNames(tree, node)))),
  ].map(node => [node.getStart(tree), node.end]);
  const inside = node => ranges.some(([start, end]) => node.getStart(tree) >= start && node.end <= end);
  // Type-only declarations have no runtime effect (property names of the context value type).
  const typeOnly = node => { for (let up = node.parent; up; up = up.parent) if (ts.isInterfaceDeclaration(up) || ts.isTypeAliasDeclaration(up)) return true; return false; };
  for (const node of all) {
    if (ts.isIdentifier(node) && P02_CTX_PROTECTED_IDS.has(node.text) && !inside(node) && !typeOnly(node)) fail(`p02 1a realtime protected identifier outside the reviewed pieces: ${node.text}`);
    const text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : ts.isJsxText(node) ? node.getText(tree) : null;
    if (text !== null && P02_CTX_PROTECTED_IDS.has(text.trim())) fail('p02 1a realtime protected identifier used as a string');
    if (text !== null && text.includes('已同步') && !inside(node)) fail('p02 1a realtime context renders a synced label outside the presentation');
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'data-global-sync-banner'
      && !(node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression?.getText(tree) === 'syncPresentation.status')) {
      fail('p02 1a realtime banner status is not the reviewed presentation status');
    }
  }
}
/** Outside the context and the connectivity module, nothing may hold/release Fresh or alias the connectivity module. */
// Module references are found with the TypeScript AST (static/dynamic import, import-equals, require, every export-from
// form). A specifier names the connectivity module when its last path segment, without query/hash and without any
// extension, is `cloudConnectivity` (fail closed: any path or alias spelling counts). Only named (or type-only) imports
// of other members are allowed; namespace/default imports, every re-export, dynamic import and require are rejected,
// and a dynamic import / require whose specifier is not a plain string literal is rejected in any src file.
// The Fresh hold names are matched on decoded AST names too (escaped identifiers, string-literal import/export names).
// `import.meta` may only be used as `import.meta.env` anywhere in src, the context file included (no `import.meta.glob`).
const P02_FRESH_HOLD_NAMES = new Set(['holdCloudFresh', 'releaseCloudFresh']);
const p02NamesConnectivity = specifier => specifier.replace(/[?#].*$/su, '').split('/')
  .some(segment => segment.replace(/\.[A-Za-z0-9]+$/u, '') === 'cloudConnectivity');
const p02ImportMetaOnlyEnv = (file, tree) => {
  for (const node of nodes(tree)) {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'meta'
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === 'env')) {
      fail(`p02 1a import.meta used beyond import.meta.env: ${file}`);
    }
  }
};
// Scope: every script-like src file is passed in (.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs). Plain-JS scripts in src are
// rejected (they would escape the TypeScript-only reviews); every module specifier in src must stay inside src/
// (relative and root-absolute specifiers are resolved segment by segment and must land inside src/; backslashes are
// rejected); eval / Function constructors and code-from-string timers are rejected (best effort, see LIMIT).
// r7: URL-scheme specifiers (data:, file:, https:, virtual:, ...) are rejected; src/ may not contain symlinks or
// submodules (git modes 120000 / 160000); outside the context file nothing may reach the Realtime channel objects
// (getChannels / channelAdapter / removeChannel(s) / .realtime / .channel(...)), the known proof-forgery path.
// LIMIT / TRUST BOUNDARY: this is a best-effort syntactic scan, not a control-flow or module-graph proof. It protects
// the exact core contracts (pins) and the known concrete bypass paths. It cannot prove that arbitrary malicious
// JavaScript in a reviewed change is unable to release the hold or forge a proof: dynamically computed code (e.g.
// `globalThis['ev' + 'al']`, a Function alias, script-element injection) is NOT excluded, and it DOES reach production
// builds (the connectivity exports exist in the bundle; there is no CSP today). That residual risk is owned by code
// review and the separate CSP item (E4). npm packages are not inspected (package.json / vite.config.ts changes are
// classified for review elsewhere).
export const P02_SRC_SCRIPT = /^src\/.+\.(?:[cm]?[jt]sx?)$/iu;
const P02_CHANNEL_API_NAMES = new Set(['getChannels', 'channelAdapter', 'removeChannel', 'removeChannels']);
const P02_CHANNEL_MEMBER_NAMES = new Set(['getChannels', 'channelAdapter', 'removeChannel', 'removeChannels', 'realtime', 'channel']);
/** src/ tree entries from `git ls-tree -r <head> -- src`: symlinks and submodules are rejected. */
export function assertP02SrcTreeModes(listing) {
  for (const row of String(listing ?? '').split(/\r?\n/u).filter(Boolean)) {
    const mode = row.split(/\s+/u)[0];
    if (mode === '120000' || mode === '160000') fail(`p02 1a symlink or submodule in src: ${row.split('\t').at(-1)}`);
  }
}
const p02SpecifierInsideSrc = (file, specifier) => {
  const clean = specifier.replace(/[?#].*$/su, '');
  if (clean.includes('\\')) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(clean)) return false; // URL scheme: data:, file:, https:, virtual:, ...
  if (!clean.startsWith('.') && !clean.startsWith('/')) return true; // package specifier (resolved from node_modules, outside this scan)
  const parts = [];
  for (const part of (clean.startsWith('/') ? clean : `${file.split('/').slice(0, -1).join('/')}/${clean}`).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (!parts.length) return false; parts.pop(); } else parts.push(part);
  }
  return parts[0] === 'src' && parts.length > 1;
};
const p02DynamicCode = node => {
  const callee = ts.isCallExpression(node) || ts.isNewExpression(node) ? node.expression : null;
  const named = expr => expr && ((ts.isIdentifier(expr) && (expr.text === 'eval' || expr.text === 'Function'))
    || (ts.isPropertyAccessExpression(expr) && (expr.name.text === 'eval' || expr.name.text === 'Function'))
    || (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression) && /^(?:eval|Function)$/u.test(expr.argumentExpression.text)));
  if (named(callee)) return true;
  // Best effort beyond direct calls: any value reference to eval, code-string timers, constructor-of-constructor.
  if (ts.isIdentifier(node) && node.text === 'eval') return true;
  const timerName = ts.isCallExpression(node) ? (ts.isIdentifier(node.expression) ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null) : null;
  const first = timerName && /^(?:setTimeout|setInterval)$/u.test(timerName) ? node.arguments[0] : null;
  if (first && (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first) || ts.isBinaryExpression(first))) return true;
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor' && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'constructor') return true;
  return false;
};
export function assertP02FreshHoldCallers(files) {
  for (const [file, text] of files) {
    if (text === null) continue;
    if (/\.(?:[cm]?jsx?)$/iu.test(file)) fail(`p02 1a non-TypeScript script in src: ${file}`);
    if (file !== 'src/providers/cloud/cloudConnectivity.ts') {
      const tree = parse(file, text);
      p02ImportMetaOnlyEnv(file, tree);
      for (const node of nodes(tree)) {
        if (p02DynamicCode(node)) fail(`p02 1a eval / Function constructor in src: ${file}`);
        const spec = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text
          : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression) ? node.moduleReference.expression.text
            : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
              && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text
              : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal) ? node.argument.literal.text : null;
        if (spec !== null && !p02SpecifierInsideSrc(file, spec)) fail(`p02 1a src module imports outside src: ${file} -> ${spec}`);
      }
    }
    if (file === P02_CTX_CONTEXT || file === 'src/providers/cloud/cloudConnectivity.ts') continue;
    if (/\b(?:holdCloudFresh|releaseCloudFresh)\b/u.test(text)) fail(`p02 1a Fresh hold used outside the reviewed boundary: ${file}`);
    const aliased = () => fail(`p02 1a connectivity module aliased: ${file}`);
    const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
    for (const node of nodes(parse(file, text))) {
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && P02_FRESH_HOLD_NAMES.has(node.text)) {
        fail(`p02 1a Fresh hold used outside the reviewed boundary: ${file}`);
      }
      // Known proof-forgery path: Realtime channel objects are reachable only inside the context file.
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && P02_CHANNEL_API_NAMES.has(node.text)) {
        fail(`p02 1a Realtime channel API used outside the context: ${file}`);
      }
      if ((ts.isPropertyAccessExpression(node) && P02_CHANNEL_MEMBER_NAMES.has(node.name.text))
        || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && P02_CHANNEL_MEMBER_NAMES.has(node.argumentExpression.text))) {
        fail(`p02 1a Realtime channel API used outside the context: ${file}`);
      }
      if (ts.isImportDeclaration(node)) {
        const spec = literal(node.moduleSpecifier);
        if (spec === null || !p02NamesConnectivity(spec)) continue;
        const clause = node.importClause;
        if (!clause) aliased(); // side-effect import of the module
        else if (clause.isTypeOnly) continue;
        else if (clause.name || (clause.namedBindings && !ts.isNamedImports(clause.namedBindings))) aliased();
        else if (clause.namedBindings && clause.namedBindings.elements.some(element => (element.propertyName ?? element.name).text === 'default')) aliased();
      } else if (ts.isExportDeclaration(node)) {
        const spec = literal(node.moduleSpecifier);
        if (spec !== null && p02NamesConnectivity(spec) && !node.isTypeOnly) aliased();
      } else if (ts.isImportEqualsDeclaration(node)) {
        if (ts.isExternalModuleReference(node.moduleReference)) {
          const spec = literal(node.moduleReference.expression);
          if (spec === null || p02NamesConnectivity(spec)) aliased();
        }
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const spec = literal(node.arguments[0]);
        if (spec === null || p02NamesConnectivity(spec)) aliased();
      } else if (ts.isImportTypeNode(node)) {
        continue; // `typeof import('...')` in a type position has no runtime effect
      }
    }
  }
}
// ---- END p02-1a realtime context contract function ----

export function assertReviewedProviderContract(file, before, after) {
  // ---- BEGIN waca-counted-transition-provider-v1 dispatch ----
  if (!wacaCountedRestoringReviewedSource && wacaCountedProviderReviewApplies(file, after)) {
    assertWacaCountedProviderContract(file, before, after);
    return;
  }
  // ---- END waca-counted-transition-provider-v1 dispatch ----
  // ---- BEGIN p02-1a provider contract dispatch ----
  if (!p02RestoringReviewedSource && p02Phase1aReviewApplies(file, after)) {
    assertP02Phase1aProviderContract(file, before, after);
    return;
  }
  // ---- END p02-1a provider contract dispatch ----
  if (file === 'src/providers/cloud/cloudRestoreSubmit.ts') {
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
      if (canonical(parse(file, before)) !== canonical(parse(file, restored))) {
        // An immutable review may add a SELECT-only generation scanner. All
        // existing writers, strict loaders, codecs and CAS checks stay exact.
        const previous = parse(file, before), current = parse(file, after);
        const functions = tree => tree.statements.filter(ts.isFunctionDeclaration)
          .map(node => [node.name?.text, canonical(tree, node)]);
        const nextFunctions = new Map(functions(current));
        for (const [name, source] of functions(previous))
          if (nextFunctions.get(name) !== source) fail('journal existing codec/identity/CAS/writer changed');
        const additions = functions(current).filter(([name]) => !new Map(functions(previous)).has(name));
        if (additions.length !== 1 || additions[0][0] !== 'readEligibleBuyAnimeJournals'
          || /\.(?:insert|update|upsert|delete)\(/u.test(additions[0][1])) fail('journal scanner contains unreviewed writes');
      }
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
  // ---- BEGIN restore-ops-g1 provider contract dispatch ----
  if (file === 'src/providers/cloud/cloudRestoreOpsScheduler.ts' || file === 'src/providers/cloud/cloudRestoreOpsMaintenance.ts') {
    assertRestoreOpsMaintenanceContract(file, before, after);
    return;
  }
  // ---- END restore-ops-g1 provider contract dispatch ----
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
    // ---- BEGIN restore-variant-duplicate-normalization-v1 (exact review) ----
    // Only the Restore panel may change, only by the exact approved statements
    // (a pre-portability duplicate-Variant normalization step and its display),
    // and every provider/RPC/proof/readback port must stay byte-identical.
    if (file === 'src/components/CloudAtomicRestorePanel.tsx'
      && reviewed?.review.id === RESTORE_VARIANT_NORMALIZATION_REVIEW
      && reviewed.row.classification === 'APPLICATION_DOMAIN_ONLY') {
      assertReviewedRestoreOrchestrationContract(file, before, after);
      assertRestoreVariantNormalizationPanelContract(git(['show', `${reviewed.review.beforeHead}:${file}`]), after);
      return true;
    }
    // ---- END restore-variant-duplicate-normalization-v1 ----
    // ---- BEGIN waca-counted-transition-restore-v1 (exact review) ----
    if (file === 'src/components/CloudAtomicRestorePanel.tsx'
      && reviewed?.review.id === WACA_TRANSITION_RESTORE_REVIEW
      && reviewed.row.classification === 'APPLICATION_DOMAIN_ONLY') {
      assertWacaTransitionPanelContract(git(['show', `${reviewed.review.beforeHead}:${file}`]), after);
      return true;
    }
    // ---- END waca-counted-transition-restore-v1 ----
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
  // ---- BEGIN p02-1a realtime context contract dispatch ----
  const p02ContextChanged = P02_REALTIME_CONTEXT_FILES.filter(file => (oldSet.has(file) || newSet.has(file))
    && sourceHash(source(baseline, file, oldSet.has(file))) !== sourceHash(source(candidate.head, file, newSet.has(file))));
  for (const file of p02ContextChanged) {
    if (!newSet.has(file)) fail(`p02 1a realtime context file removed: ${file}`);
    assertP02RealtimeContextContract(file, source(candidate.head, file, true));
  }
  // Every inspection, changed or not: nothing else in src may hold/release Fresh or alias the connectivity module.
  assertP02FreshHoldCallers(newFiles.filter(file => P02_SRC_SCRIPT.test(file)).map(file => [file, source(candidate.head, file, true)]));
  assertP02SrcTreeModes(git(['ls-tree', '-r', candidate.head, '--', 'src']));
  // ---- END p02-1a realtime context contract dispatch ----
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
