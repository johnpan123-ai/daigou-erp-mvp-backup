import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const configFile=fileURLToPath(new URL('fixtures/cloud-atomic-restore-vite.config.mjs',import.meta.url));
const server=await createServer({root:ROOT,configFile,mode:'staging',server:{port:4278,strictPort:true}});
await server.listen();
const mod=await server.ssrLoadModule('/src/providers/cloud/cloudRestoreIntegrityAudit.ts');
const domain=await server.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
const snapshot=JSON.parse(readFileSync(process.env.RESTORE_AUDIT_SNAPSHOT
  || 'C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-09-21-125752.json','utf8'));
const counts=snapshot.manifest.counts;
const dto={
  schema_version:'cloud-restore-integrity-audit-v1',audited_at:'2026-09-21T15:00:00Z',epoch:5,
  table_counts:counts,total_rows:17776,relationship_hash:snapshot.manifest.relationshipHash,
  integrity:Object.fromEntries(mod.AUDIT_CHECKS.map(k=>[k,0])),
  audit_policy:{policy:'cross-environment-audit-null-v1',covered_updated_by_non_null_count:0,covered_updated_by_null_count:17776},
  expected_manifest:{counts:{...counts},total_rows:17776,relationship_hash:snapshot.manifest.relationshipHash},
  comparison:{counts_match:true,relationship_hash_match:true},
  restore_state:{
    latest_completed:{attempt_id:'22222222-2222-4222-8222-222222222222',status:'completed',result_epoch:5,replayed:false,
      source_fingerprint:snapshot.manifest.snapshotFingerprint,effective_fingerprint:'5591800cd0c402e84312f66d9c8aaeecacd971b1a72f0e628dca1efcc6f93a8f',
      completed_at:'2026-09-21T14:00:00Z',source_transformed_updated_by_count:15443},
    pending_count:0,executing_count:0,processing_request_count:0,active_lock_count:0,metadata_inconsistency_count:0,partial_state:'not_detected',
  },
};
assert.equal(mod.cloudRestoreAuditVerdict(mod.parseCloudRestoreIntegrityAudit(dto)),'PASS');
for (const mutate of [
  d=>{d.total_rows=1;},d=>{delete d.table_counts.product_variants;},
  d=>{d.epoch=-1;},d=>{d.relationship_hash='bad';},d=>{delete d.integrity.orphan_count;},
  d=>{d.restore_state.latest_completed.status='executing';},d=>{d.audit_policy.policy='unknown';},
]) { const d=structuredClone(dto);mutate(d);assert.throws(()=>mod.parseCloudRestoreIntegrityAudit(d)); }
for (const mutate of [
  d=>{d.integrity.orphan_count=1;},d=>{d.restore_state.executing_count=1;},
  d=>{d.restore_state.active_lock_count=1;},d=>{d.audit_policy.covered_updated_by_non_null_count=1;d.audit_policy.covered_updated_by_null_count--;},
  d=>{d.expected_manifest.counts.product_groups++;},d=>{d.expected_manifest.relationship_hash='a'.repeat(64);},
]) { const d=structuredClone(dto);mutate(d);assert.equal(mod.cloudRestoreAuditVerdict(mod.parseCloudRestoreIntegrityAudit(d)),'FAIL'); }
const absent=structuredClone(dto);absent.expected_manifest=null;absent.restore_state.latest_completed=null;
assert.equal(mod.cloudRestoreAuditVerdict(mod.parseCloudRestoreIntegrityAudit(absent)),'PENDING');
assert(!JSON.stringify(mod.parseCloudRestoreIntegrityAudit({...dto,snapshot:'must-not-leak',auth_uuid:'must-not-leak'})).includes('must-not-leak'));
const rpcNames=[];
await mod.readCloudRestoreIntegrityAudit({rpc:async n=>{rpcNames.push(n);return {data:dto,error:null};}});
assert.deepEqual(rpcNames,['erp_read_cloud_restore_integrity_audit']);
await assert.rejects(()=>mod.readCloudRestoreIntegrityAudit({rpc:async()=>({data:null,error:{message:'raw secret'}})}),e=>!e.message.includes('raw secret'));

const browser=await chromium.launch({executablePath:process.env.CORE_TEST_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try {
  const page=await browser.newPage();
  const rpc=[],unexpected=[],errors=[];
  let current=dto,fail=false,hold=null;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if (url.hostname==='127.0.0.1') return route.continue();
    if (url.hostname==='rhfdjsklfrgpoqsaqpkn.supabase.co' && url.pathname==='/rest/v1/rpc/erp_read_cloud_restore_integrity_audit') {
      rpc.push(url.pathname);
      if (hold) await hold;
      return route.fulfill({status:fail?500:200,contentType:'application/json',body:JSON.stringify(fail?{message:'must-not-render-secret'}:current)});
    }
    unexpected.push(url.origin+url.pathname);
    return route.abort();
  });
  await page.goto('http://127.0.0.1:4278/tests/fixtures/cloud-restore-integrity-audit.html');
  const audit=page.getByTestId('restore-integrity-audit');
  const openAdvancedAudit=async()=>{
    const advanced=page.getByTestId('cloud-restore-advanced-tools');
    await advanced.waitFor();
    if (!(await advanced.evaluate(node=>node.open))) await advanced.locator('summary').click();
    await audit.waitFor();
  };
  await openAdvancedAudit();
  assert.equal(rpc.length,0,'Manual-only: mounting Settings must not audit');
  const countText=()=>page.locator('.kpi-grid > .card:first-child .font-semibold').allTextContents();
  const logical=await countText();
  let release;hold=new Promise(r=>{release=r;});
  await page.getByRole('button',{name:'Restore Integrity Audit',exact:true}).evaluate(b=>{
    b.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    b.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  });
  await page.waitForFunction(()=>document.querySelector('[aria-label="還原完整性稽核"] button')?.disabled);
  release();hold=null;
  await page.getByTestId('restore-integrity-result').waitFor();
  assert.equal(rpc.length,1,'Double click produces exactly one read RPC');
  const text=await audit.innerText();
  assert(text.includes('PASS · epoch 5 · raw total 17776'));
  for (const [,t] of domain.CLOUD_RESTORE_TABLES) {
    assert.deepEqual(await audit.locator('tr').filter({has:page.getByText(t,{exact:true})}).locator('td').allTextContents(),[t,String(counts[t]),String(counts[t])]);
  }
  assert.deepEqual(await countText(),logical,'Audit must not overwrite Settings logical statistics or caches');
  assert(!logical.join('|').includes('4939'),'Fixture distinguishes active/logical from raw');
  assert.equal(await page.evaluate(()=>window.__RESTORE_AUDIT__.writes()),0);
  for (const role of ['staff',null]) {
    await page.evaluate(role=>window.__RESTORE_AUDIT__.render(role),role);
    await audit.waitFor({state:'detached'});
  }
  await page.evaluate(()=>window.__RESTORE_AUDIT__.render('owner','local'));
  assert.equal(await audit.count(),0,'Local mode must not expose Cloud audit');
  await page.evaluate(()=>window.__RESTORE_AUDIT__.render('owner'));
  await openAdvancedAudit();
  fail=true;
  await page.getByRole('button',{name:'Restore Integrity Audit',exact:true}).click();
  await audit.getByRole('alert').waitFor();
  assert(!(await page.locator('body').innerText()).includes('must-not-render-secret'));
  fail=false;current=structuredClone(dto);current.restore_state.executing_count=1;current.restore_state.partial_state='unproven';
  await page.getByRole('button',{name:'Restore Integrity Audit',exact:true}).click();
  await audit.getByText(/FAIL · epoch 5/).waitFor();
  hold=new Promise(r=>{release=r;});
  await page.getByRole('button',{name:'Restore Integrity Audit',exact:true}).click();
  await page.evaluate(()=>window.__RESTORE_AUDIT__.render('staff'));
  await audit.waitFor({state:'detached'});
  release();hold=null;
  await page.evaluate(()=>window.__RESTORE_AUDIT__.render('owner'));
  await openAdvancedAudit();
  assert.equal(await page.getByTestId('restore-integrity-result').count(),0,'Old response must not leak into new user/mount');
  assert.equal(await page.evaluate(()=>window.__RESTORE_AUDIT__.writes()),0);
  assert.deepEqual(unexpected,[]);
  assert.deepEqual(errors,[]);
  assert(rpc.every(p=>p.endsWith('/erp_read_cloud_restore_integrity_audit')));
  console.log(JSON.stringify({status:'PASS',realSettings:true,realProviderTransport:true,manualReadRPCs:rpc.length,
    mutationCalls:0,unexpectedNetwork:0,liveCalls:0,rawVsLogicalSeparated:true,safeErrors:true},null,2));
} finally {await browser.close();await server.close();}
