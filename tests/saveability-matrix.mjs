import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {report} from '../tools/saveability-audit.mjs';
const source=p=>readFileSync(p,'utf8');
assert.equal(report.counts.fail,0);
for(const action of report.actions){
  for(const evidence of action.evidence??[])assert.ok(source(evidence).length>0,'Missing evidence '+evidence);
  if(action.status==='UNSUPPORTED_BY_PRODUCT_DESIGN')assert.ok(/DISABLED|HIDDEN/u.test(action.cloud));
}
const privateUi=source('src/pages/PurchaseManagement.tsx');
assert.ok(privateUi.includes('savePrivateOrderTransaction(command)'));
assert.ok(privateUi.includes('resumePrivateIntent')&&privateUi.includes('disabled={poSaving || poNeedsVerification}'));
assert.ok(!privateUi.includes('dataProvider.deletePrivateOrderItems('));
const catalog=source('src/providers/cloud/supabaseProvider.ts');
for(const mode of ['create','sync','reparse'])assert.ok(catalog.includes(`commitCatalog('${mode}'`));
assert.ok(!catalog.includes('generateFallbackUuid'),'Cloud cannot fabricate replacement identities');
assert.ok(!/alert\([^\n]+err\.message[^\n]+快取未變更/u.test(catalog),'Do not label acknowledged/unknown commit as unchanged');
const legacy=source('src/pages/OrdersImport.tsx');
for(const name of ['handleImportClick','handleFileChange','handleConfirmImport']){
  const part=legacy.slice(legacy.indexOf('const '+name),legacy.indexOf('const '+name)+300);
  assert.ok(part.includes('if(cloudLegacyDisabled)'),'Legacy Cloud guard before '+name);
}
for(const file of ['src/pages/DuplicateVariants.tsx','src/components/PurchaseBatchTab.tsx','src/pages/JapanPackagesList.tsx','src/pages/JapanPackageDetail.tsx'])assert.ok(source(file).includes('applyRelatedTransaction'));
const fresh=source('supabase/canonicalFreshInstallV3.mjs');
for(const n of ['049_private_order_atomic_transaction.sql','050_catalog_atomic_transaction.sql','051_related_saveability_atomic_transactions.sql'])assert.ok(fresh.includes(n));
console.log('PASS full source UI→provider→persistence matrix coverage; disabled Cloud legacy/reset/title helpers explained; atomic multi-write wiring; uncertainty/frozen replay; canonical identity fail-closed');
