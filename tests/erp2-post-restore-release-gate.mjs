import {spawnSync} from 'node:child_process';
for(const script of ['tests/erp1-v1-restore-compatibility.mjs','tests/buyanime-post-restore-isolated.mjs']) {
 const run=spawnSync(process.execPath,[script],{cwd:process.cwd(),env:process.env,stdio:'inherit'});
 if(run.error)throw run.error;
 if(run.status!==0)throw new Error('POST_RESTORE_RELEASE_GATE_FAILED:'+script);
}
console.log('PASS permanent ERP1/current Restore, immediate BuyAnime/WACA, native Atomic Restore release gate');
