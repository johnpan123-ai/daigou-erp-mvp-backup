// Disposable, localhost-only real React panel test; no production session or credential.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';
const tables=JSON.parse(await readFile(process.env.ERP2_CURRENT_REAL_SNAPSHOT,'utf8'));
const manifest=tables.manifest;
const attempt='536b27e7-aaf5-4722-aaaa-3dee5f790fbb',trace='20e5a41f-7622-449c-b190-91570df8c7ed',execution='8d5c1748-34ab-4651-9a89-ba11b9684d09';
const result={ok:true,manifest,restoreEpoch:24,snapshotFingerprint:manifest.snapshotFingerprint,rollbackSnapshotId:'fixture'};
const summary={contract:'restore-committed-verification-v1',status:'RESTORE_COMMITTED_VERIFIED',attemptId:attempt,traceId:trace,executionId:execution,
 restoreEpoch:24,businessGeneration:6804,snapshotFingerprint:manifest.snapshotFingerprint,serverSnapshotFingerprint:'a'.repeat(64),serverRelationshipHash:'b'.repeat(64),
 counts:manifest.counts,totalRows:manifest.totalRows,duplicateCount:0,missingIdentityCount:0,orphanCount:0,generationCertified:true,elapsedMs:100};
const bridge=`import React from 'react';
const mode=new URLSearchParams(location.search).get('case');
const id=${JSON.stringify({attemptId:attempt,traceId:trace,executionId:execution})};
const summary=${JSON.stringify(summary)},result=${JSON.stringify(result)};
let releaseRefresh,releaseRead; const f=window.fixture={execute:0,read:0,refresh:0,deadlineWrite:0,pending:null,completed:0,cache:'OLD',failure:mode};
window.addEventListener('cloud-restore-authoritative-pending',e=>f.pending=e.detail.attemptId);
window.addEventListener('cloud-restore-completed',e=>{if(f.pending===e.detail.attemptId){f.pending=null;f.completed++;}});
f.release=()=>{f.cache='AUTHORITATIVE';releaseRefresh?.(true);};
f.releaseRead=()=>releaseRead?.();
export const useAuth=()=>({user:{id:'owner'}}),useRole=()=>({role:'owner'});
export const getProviderMode=()=> 'cloud',supabaseEnvironment={projectRef:'rhfdjsklfrgpoqsaqpkn'};
const conn={status:'online',readStatus:'fresh-online'};export const getCloudConnectivitySnapshot=()=>conn,subscribeCloudConnectivity=()=>()=>{};
export const useCloudResourceSync=()=>({refreshAuthoritative:async()=>{f.refresh++;if(mode==='refresh-fail')return false;
 if(mode==='hold-refresh')return new Promise(r=>releaseRefresh=r);f.cache='AUTHORITATIVE';return true;}});
export const dataProvider={getPendingCloudRestoreAttempts:async()=>[],getLatestCompletedCloudRestoreAttempt:async()=>id,
 reconcileCloudRestoreAttempt:async()=>({status:'completed',...id,restoreResult:result,effectiveFingerprint:result.snapshotFingerprint,expectedEpoch:23}),
 verifyCommittedCloudRestore:async()=>{f.read++;if(mode==='network'&&f.read===1)throw new TypeError('network');
 if(mode==='hold-read'&&f.read===1)await new Promise(r=>releaseRead=r);
 return {...summary,...(mode==='mismatch'?{status:'RESTORE_COMMITTED_STATE_MISMATCH',generationCertified:false}:{})};},
 restoreCloudSnapshot:async()=>{f.execute++;throw Error('EXECUTE_FORBIDDEN');}};
export const readCloudDeadlineRestoreStage=async()=>({legacyBackup:mode!=='deadline-missing'}),clearCloudDeadlineRestoreStage=async()=>{},stageCloudDeadlineRestore=async()=>{};
export const readDeadlineDurableBackup=async()=>({}),restoreDeadlineDurableBackup=async()=>{f.deadlineWrite++;throw Error('DEADLINE_WRITE_FORBIDDEN');};
export const validateDeadlineDurableBackup=x=>x;
export default function Empty(){return null;}
`;
const names=['auth/authContext','auth/useRole','contexts/CloudRealtimeSyncContext','providers/dataProvider',
 'providers/providerMode','providers/cloud/supabaseClient','providers/cloud/cloudConnectivity',
 'lib/cloudDeadlineRestoreStage','lib/closingDateSidecarBackup','components/CloudRestoreIntegrityAudit'];
const server=await createServer({configFile:false,plugins:[{name:'isolated-restore-verification',enforce:'pre',
 resolveId(id){if(id==='/ui-entry.jsx')return '\0ui-entry.jsx';if(id==='virtual:restore-fixture')return '\0restore-fixture';
 if(names.some(n=>id.replace(/\.tsx?$/,'').endsWith('/'+n)))return '\0restore-fixture';},
 load(id){if(id==='\0restore-fixture')return bridge;if(id==='\0ui-entry.jsx')return `import React from 'react';
 import {createRoot} from 'react-dom/client';import Panel from '/src/components/CloudAtomicRestorePanel.tsx';
 createRoot(document.getElementById('root')).render(React.createElement(Panel));`;},
 configureServer(s){s.middlewares.use(async(req,res,next)=>{
 if(req.url?.startsWith('/fixture')){res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml(req.url,`<div id="root"></div><script type="module" src="/ui-entry.jsx"></script>`));}
 else next();});}},react()],
 optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','lucide-react']},
 server:{host:'127.0.0.1',port:4288,strictPort:true}});
let browser;const cases=[];
try{
 await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.CORE_TEST_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const context=await browser.newContext();
 for(const mode of ['success','network','refresh-fail','mismatch','deadline-missing','hold-refresh','hold-read']){
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  await page.goto('http://127.0.0.1:4288/fixture?case='+mode);
  await page.getByTestId('cloud-restore-reverify-latest').click();
  if(mode==='hold-refresh'){
   await page.waitForFunction(()=>window.fixture.refresh===1);
   assert.equal(await page.evaluate(()=>window.fixture.completed),0);
   assert.equal(await page.evaluate(()=>window.fixture.cache),'OLD');
   await page.evaluate(()=>window.fixture.release());
  }
  if(mode==='hold-read'){
   await page.waitForFunction(()=>window.fixture.read===1);
   // A completion for A must NOT clear a newer B pending identity.
   await page.evaluate(()=>window.dispatchEvent(new CustomEvent('cloud-restore-authoritative-pending',{detail:{attemptId:'newer-B'}})));
   await page.evaluate(()=>window.fixture.releaseRead());
  }
  if(['refresh-fail','mismatch','deadline-missing'].includes(mode)){
   await page.getByTestId('cloud-restore-reverify').waitFor();
   await page.waitForFunction(()=>document.querySelector('[data-testid="cloud-restore-status"]')?.getAttribute('role')==='alert');
   assert.equal(await page.evaluate(()=>window.fixture.completed),0);
   assert.ok(await page.evaluate(()=>window.fixture.pending));
  }else{
   await page.getByTestId('cloud-restore-result').waitFor();
   assert.equal(await page.evaluate(()=>window.fixture.cache),'AUTHORITATIVE');
   assert.equal(await page.evaluate(()=>window.fixture.pending),mode==='hold-read'?'newer-B':null);
  }
  const final=await page.evaluate(()=>({execute:window.fixture.execute,deadlineWrite:window.fixture.deadlineWrite,read:window.fixture.read}));
  assert.equal(final.execute,0);assert.equal(final.deadlineWrite,0);assert.deepEqual(errors,[]);
  if(mode==='network')assert.equal(final.read,3);
  assert.doesNotMatch(await page.locator('body').innerText(),/\[object Object\]|safe code：UNKNOWN/);
  cases.push(mode+' PASS');await page.close();
 }
 // Reload with the product-persisted pending identity must reconcile, not Execute.
 const p=await context.newPage();await p.goto('http://127.0.0.1:4288/fixture?case=refresh-fail');
 await p.getByTestId('cloud-restore-reverify-latest').click();
 await p.waitForFunction(()=>document.querySelector('[data-testid="cloud-restore-status"]')?.getAttribute('role')==='alert');
 await p.goto('http://127.0.0.1:4288/fixture?case=success');
 await p.getByTestId('cloud-restore-result').waitFor();assert.equal(await p.evaluate(()=>window.fixture.execute),0);
 cases.push('reload pending receipt -> verified authoritative, Execute=0 PASS');
 console.log(JSON.stringify({result:'PASS',cases,liveBusinessWrite:0,liveRestore:0}));
}finally{await browser?.close();await server.close();}
