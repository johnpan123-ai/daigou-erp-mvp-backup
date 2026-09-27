import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const base = '151fe2fd1fd07ec168affa72c7a27ee785c38fb6';
const protectedPaths = ['src/providers', 'src/contexts', 'src/hooks', 'src/lib', 'functions', 'supabase', 'config',
  'src/components/CloudAtomicRestorePanel.tsx', 'src/components/ClosingDateResolutionWorkbench.tsx',
  'src/pages/OutboundShipmentDetail.tsx',
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
const originalJapan = execFileSync('git', ['show', `${base}:src/pages/JapanPackageDetail.tsx`], { encoding: 'utf8' });
const currentJapan = readFileSync('src/pages/JapanPackageDetail.tsx', 'utf8');
const newJapanHandlers = handlers(currentJapan, 'JapanPackageDetail.tsx');
for (const handler of handlers(originalJapan, 'JapanPackageDetail.tsx')) {
  const index = newJapanHandlers.indexOf(handler);
  assert.ok(index >= 0, `Japan Package existing handler preserved: ${handler.slice(0, 70)}`);
  newJapanHandlers.splice(index, 1);
}
assert.deepEqual(newJapanHandlers, ["onChange={event => setContentSortSelection({ packageId: id, mode: event.target.value as JapanPackageDisplaySort })}"], 'Japan Package adds only the display sort handler');
const settings = readFileSync('src/pages/Settings.tsx', 'utf8');
assert.ok(settings.includes('<PageShell') && settings.includes('<PageHeader') && settings.includes('<SystemInformation'), 'Settings uses the shared desktop shell, header, and diagnostics');
const appLayout = readFileSync('src/components/layout/AppLayout.tsx', 'utf8');
assert.ok(appLayout.includes("'/settings'"), 'Settings participates in the shared desktop workspace');
assert.ok(appLayout.includes('ERP_SYSTEM_SHORT_NAME') && appLayout.includes('ERP_SYSTEM_VERSION'), 'Sidebar uses the shared compact identity');
const app = readFileSync('src/App.tsx', 'utf8');
for (const [name, source] of [['App', app], ['Purchasing', readFileSync('src/pages/Purchasing.tsx', 'utf8')], ['Japan Package Detail', currentJapan]]) {
  assert.ok(!/Hotfix H-2 display v2|JapanDetail UI v2\.2|Purchasing UI width fix v1/.test(source), `${name}: no scattered customer-facing version labels`);
}
const systemInfo = readFileSync('src/components/layout/SystemInformation.tsx', 'utf8');
assert.ok(systemInfo.includes('navigator.clipboard.writeText') && systemInfo.includes('複製失敗，請再試一次'), 'System information has safe copy feedback');
assert.ok(!/service_role|Authorization|Cookie|JWT/.test(systemInfo), 'Diagnostics never include credentials');
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
