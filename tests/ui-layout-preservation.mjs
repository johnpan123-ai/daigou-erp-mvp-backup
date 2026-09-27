import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const base = '151fe2fd1fd07ec168affa72c7a27ee785c38fb6';
const protectedPaths = ['src/providers', 'src/contexts', 'src/hooks', 'src/lib', 'functions', 'supabase', 'config',
  'src/components/CloudAtomicRestorePanel.tsx', 'src/components/ClosingDateResolutionWorkbench.tsx',
  'src/pages/JapanPackageDetail.tsx', 'src/pages/OutboundShipmentDetail.tsx',
  'scripts/verify-erp-deployment-identity.mjs', 'tests/fixtures/cloud-p0-2-react-harness.mjs'];
assert.equal(execFileSync('git', ['diff', '--name-only', base, '--', ...protectedPaths], { encoding: 'utf8' }).trim(), '', 'Protected business/runtime/fixture source must be unchanged');
const pages = ['Dashboard', 'Inventory', 'PurchaseRecords', 'RecentPurchases', 'Purchasing', 'JapanPackagesList', 'OutboundShipmentsList', 'UnlistedItems', 'DuplicateVariants'];
function handlers(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result = [];
  function visit(node) {
    if (ts.isJsxAttribute(node) && /^on[A-Z]/.test(node.name.getText(tree))) {
      result.push(node.getText(tree).replace(/\s+/g, ' '));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return result.sort();
}
for (const page of pages) {
  const path = `src/pages/${page}.tsx`;
  const before = execFileSync('git', ['show', `${base}:${path}`], { encoding: 'utf8' });
  const after = readFileSync(path, 'utf8');
  assert.deepEqual(handlers(after, path), handlers(before, path), `${page}: event handlers unchanged`);
  assert.ok(after.includes('<PageHeader'), `${page}: shared header`);
  assert.ok(after.includes('<PageShell'), `${page}: desktop-only shell opt-in`);
  assert.ok(!after.includes('NO_MATCH_LAYOUT_FIXTURE') && !after.includes("'長商品名稱 '.repeat"), `${page}: fixture strings must not enter product UI source`);
}
const workspaceCss = readFileSync('src/styles/workspace.css', 'utf8');
const shell = readFileSync('src/components/layout/PageHeader.tsx', 'utf8');
assert.ok(workspaceCss.trimStart().startsWith('/* Desktop-only'));
assert.ok(workspaceCss.includes('@media (min-width: 768px)'));
assert.ok(!workspaceCss.includes('max-width: 767px'), 'No new mobile breakpoint rules');
assert.ok(shell.includes("isMobile ? '' : 'workspace-page'"), 'Mobile mode must not receive workspace CSS');
assert.ok(shell.includes('isMobile ? mobileStyle : style'), 'Original mobile styles must be retained');
assert.ok(!/experimental|VITE_MODE|VITE_DEPLOYMENT_ENV/i.test(shell + workspaceCss), 'Canonical layout cannot be environment-specific');
execFileSync('git', ['merge-base', '--is-ancestor', 'e565d067f49c95cf71dd6c95c5fab5b4749558f8', 'HEAD']);
console.log('PASS canonical ancestry; protected runtime/data/contracts unchanged; nine shared desktop-only shells/headers; handlers and mobile styles preserved; fixture names isolated');
