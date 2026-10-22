// Windows integration gate; every database write targets a disposable loopback database.
import {spawnSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const out=resolve(process.env.R5_GATE_OUTPUT||'scratch/r5-seven-evidence');mkdirSync(out,{recursive:true});
const main='C:/Users/小河馬/.gemini/antigravity/scratch/daigou-erp-mvp';
const env={...process.env,WACA_ISOLATED_PG_URL:'postgresql://postgres@127.0.0.1:55492/waca_v3_base',WACA_TEST_SAFEUPDATE_LIBRARY:'/tmp/erp2-waca-21000-safeupdate.k8oEUd/safeupdate.so',WACA_TEST_POSTGREST_BINARY:'/tmp/erp2-waca-074-postgrest.5dmHGR/postgrest',WACA_TEST_POSTGREST_PORT:'4497',VITE_DEPLOYMENT_ENV:'staging',VITE_SUPABASE_URL:'https://rhfdjsklfrgpoqsaqpkn.supabase.co',VITE_SUPABASE_ANON_KEY:'isolated-test-key-not-a-real-credential',P0_ESLINT_BASELINE:'23a02377044c7cf56a41aabe1ddce79fc0535df5',ERP1_V1_REAL_SNAPSHOT:main+'/scratch/claude-handoff-erp2-20261010/fixtures/ERP1_RAW_V1_READONLY.json',ERP2_CURRENT_REAL_SNAPSHOT:main+'/scratch/claude-handoff-erp2-20261010/fixtures/ERP2_CURRENT_BACKUP.json',ERP2_V2_DUPSKU_SNAPSHOT:'C:/Users/小河馬/Downloads/cloud-authoritative-backup-2026-10-15 (4).json',ERP2_EGRESS_BACKUP:'C:/Users/小河馬/Downloads/cloud-authoritative-backup-2026-10-16.json',OUTBOUND_RACE_SNAPSHOT:'C:/Users/小河馬/Downloads/workbench-backup-2026-08-15.json',OUT:join(out,'ui'),RESTORE_POSTCOMMIT_EVIDENCE_DIR:join(out,'postcommit')};
export const gates=[
 'closing-date-input-validation','r5-closing-date-react','r5-owner-preview-ui','japan-package-bulk-receiving-postgrest',
 'r5-core-source-safety-postgrest','r5-mode-draft-react','r5-core-provider-guard',
 'cloud-outbound-shipment-transaction','cloud-outbound-shipment-provider-integration','related-saveability-isolated',
 'cloud-japan-package-transaction','cloud-japan-package-provider-integration','partial-receiving-outbound-route',
 'outbound-receiving-save-race','japan-package-transaction-ui','purchase-basic-info-save-behavior',
 'cloud-field-cas','cloud-field-cas-react','cloud-realtime-draft-catchup','cloud-realtime-react-pages',
 'cloud-local-data-isolation','cloud-auth-recovery-react','p02-1a-provider-guard','p02-1a-context-guard',
 'waca-order-recognition-postgrest','waca-counted-transition','waca-counted-restore-e2e',
 'erp1-v1-restore-compatibility','basic-info-backup-restore-isolated','restore-postcommit-verification',
 'cloud-backup-next-restore-e2e','catalog-atomic-isolated','erp2-reviewed-change-impact',
 'p0-eslint-baseline-delta','typescript','build','r5-seven-change-impact','realtime-full-read-budget',
];
const names=process.argv.slice(2);const results=[];
env.ERP1_V1_WACA_SNAPSHOT='C:/Users/小河馬/Downloads/cloud-erp-snapshot-2026-10-16-021720.json';
env.ERP2_V2_WACA_SNAPSHOT=main+'/scratch/r5-codex-integration-20261022/CLOUD_BACKUP_INITIAL.json';
for(const name of names.length?names:gates){
 if(!gates.includes(name))throw Error('UNKNOWN_GATE:'+name);
 const local={...env};if(['erp1-v1-restore-compatibility','basic-info-backup-restore-isolated','related-saveability-isolated','restore-postcommit-verification','waca-counted-restore-e2e'].includes(name))local.ERP2_CORE_FIX_TEST_CANDIDATE='1';
 if(name==='erp1-v1-restore-compatibility')local.ERP1_RESTORE_EVIDENCE_OUT='scratch/r5-seven-erp1-compat';
 const args=name==='typescript'?['node_modules/typescript/bin/tsc','-b']:name==='build'?['node_modules/vite/bin/vite.js','build','--mode','next','--configLoader','runner']:name==='r5-seven-change-impact'?['scripts/r5-seven-change-impact.mjs']:['tests/'+name+'.mjs'];
 const startedAt=new Date().toISOString(),start=Date.now();console.log('RUN '+name);
 const r=spawnSync(process.execPath,args,{encoding:'utf8',env:local,timeout:600000,maxBuffer:32*1024*1024});
 const log=(r.stdout??'')+(r.stderr??'')+(r.error?.message??'');
 const path=join(out,`${name}-${start}.log`);writeFileSync(path,log);
 results.push({name,startedAt,completedAt:new Date().toISOString(),exitCode:r.status,result:r.status===0?'PASS':'FAIL',elapsedMs:Date.now()-start,path,sha256:createHash('sha256').update(log).digest('hex')});
 writeFileSync(join(out,'gates-'+process.pid+'.json'),JSON.stringify(results,null,2));console.log((r.status===0?'PASS ':'FAIL ')+name);if(r.status!==0)console.log(log.slice(-5000));
}
console.log(JSON.stringify(results));process.exitCode=results.every(r=>r.result==='PASS')?0:1;
