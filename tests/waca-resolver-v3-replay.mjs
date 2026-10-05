import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {isolatedDatabase,owner} from './helpers/saveability-isolated.mjs';
const evidence=process.env.WACA_V3_EVIDENCE_DIR;
assert.ok(evidence,'Fresh SELECT-only Catalog evidence required');
const data=JSON.parse(readFileSync(process.env.WACA_BACKUP_SCALE_FIXTURE,'utf8'));
const fresh=table=>JSON.parse(readFileSync(evidence+'/'+table+'.json','utf8'));
const activeVariants=fresh('product_variants').filter(v=>!v.deleted_at);
const inventory=fresh('inventory_items').filter(v=>!v.deleted_at);
const db=await isolatedDatabase();
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},appType:'custom'});
try{
  for(const id of new Set(Object.values(data).flatMap(rows=>rows.map(r=>r.updated_by).filter(id=>id&&id!==owner))))await db.sql.query('insert into auth.users(id,email) values($1,$2) on conflict do nothing',[id,'isolated@example.invalid']);
  const audit=(await db.sql.query('select public.erp_cloud_restore_audit_dataset($1) report',[data])).rows[0].report;
  const manifest={schemaVersion:'cloud-erp-snapshot-v2',resourceCount:24,counts:audit.table_counts,totalRows:Number(audit.total_rows),orphanCount:0,duplicateVariantIdCount:0,duplicateVariantLocalIdCount:0};
  assert.equal((await db.sql.query("select public.erp_restore_cloud_snapshot($1,repeat('a',64),$2,$3,'isolated-resolver-v3') result",[randomUUID(),data,manifest])).rows[0].result.ok,true);
  const dbIds=new Set((await db.sql.query('select id::text from public.product_variants')).rows.map(r=>r.id));
  assert.ok(activeVariants.every(v=>dbIds.has(v.id)),'Fresh Catalog identities must exist in isolated recovery fixture');
  const core=await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const storage=await vite.ssrLoadModule('/src/waca/nextStorage.ts');
  const masters=await vite.ssrLoadModule('/src/waca/masterReference.ts');
  const parser=await vite.ssrLoadModule('/src/waca/workbookParser.ts');
  const flow=await vite.ssrLoadModule('/src/waca/confirmFlow.ts');
  const rpc=async(name,body)=>{const r=await db.http('/rpc/'+name,body);assert.equal(r.status,200,JSON.stringify({code:r.data?.code,rpc:name}));return r.data;};
  // Only disposable WACA state: preserve the historical cutover forensic audit.
  await db.sql.query(`begin; delete from public.waca_order_items; delete from public.waca_orders; delete from public.waca_mappings;
    delete from public.waca_master_links; delete from public.waca_import_batches;
    update public.waca_state set revision=0, mode='ORDER_DRIVEN_ACTIVE',payload=jsonb_set(payload,'{mode}','"ORDER_DRIVEN_ACTIVE"');
    update public.product_variants set waca_auto_quantity=0;
    commit;`);
  const invariantSql=`select jsonb_build_object(
    'inventory',(select md5(string_agg(to_jsonb(t)::text,'' order by id)) from public.inventory_items t),
    'groups',(select md5(string_agg(to_jsonb(t)::text,'' order by id)) from public.product_groups t),
    'cutover',(select md5(string_agg(to_jsonb(t)::text,'' order by id)) from public.waca_cutover_audit t),
    'outbound',(select md5(string_agg(to_jsonb(t)::text,'' order by id)) from public.outbound_shipments t)) proof`;
  const before=(await db.sql.query(invariantSql)).rows[0].proof;
  await db.startPostgrest();
  const files=readdirSync(process.env.USERPROFILE+'/Downloads').filter(n=>/^orders-.*\.xlsx$|^(?:old )?waca資料\.xlsx$/iu.test(n))
    .sort((a,b)=>(a.match(/2026\d{10}/u)?.[0]??'20260926160651').localeCompare(b.match(/2026\d{10}/u)?.[0]??'20260926160651'));
  const summary={result:'PASS',engine:'disposable PostgreSQL + actual atomic RPC + actual domain',liveMutation:0,files:[],parentEvidence:'existing durable mapping JSON'};
  for(const name of files){
    const current=await rpc('erp_read_waca_snapshot');
    const links=masters.mergeMyAcgMasterLinks(masters.linksFromMyAcgInventory(inventory,activeVariants,'CURRENT_CATALOG','').links,current.masterLinks);
    const master=masters.buildWacaMasterReference(activeVariants,links);
    const repo=storage.repositoryFromSnapshot(current,activeVariants),rows=parser.parseWacaWorkbook(readFileSync(process.env.USERPROFILE+'/Downloads/'+name)).rows;
    const id=randomUUID(),result=core.importWacaRows(rows,repo,master,id);
    assert.deepEqual(result.errors,[]);assert.deepEqual(result.statusConflicts,[]);
    const batch={id,fileName:name,importedAt:new Date().toISOString(),rows:rows.length,inserted:result.inserted,updated:result.updated,unchanged:result.unchanged,result,conflictRows:[]};
    const candidate=storage.snapshotFromRepository(current,repo,[...current.batches,batch],links);
    const committed=await rpc('erp_commit_waca_snapshot',{p_snapshot:flow.wacaAtomicDelta(current,candidate),p_expected_revision:current.revision,p_update_auto_quantity:true});
    assert.equal(committed.revision,current.revision+1);
    const saved=await rpc('erp_read_waca_snapshot');
    const expected=new Map(repo.autoQuantities);
    const actual=(await db.sql.query('select id::text,waca_auto_quantity from public.product_variants where deleted_at is null')).rows;
    assert.ok(actual.every(v=>Number(v.waca_auto_quantity)===(expected.get(v.id)??0)),'full durable-order quantity parity');
    assert.equal(new Set(saved.items.map(v=>v.key)).size,saved.items.length);
    assert.equal(new Set(saved.mappings.map(v=>v.feature)).size,saved.mappings.length);
    summary.files.push({file:name,revision:saved.revision,rows:rows.length,auto:result.matched,pending:result.unmatched+result.multipleCandidates});
  }
  assert.deepEqual((await db.sql.query(invariantSql)).rows[0].proof,before,'non-WACA data / cutover audit preserved');
  const final=await rpc('erp_read_waca_snapshot');
  Object.assign(summary,{orders:final.orders.length,items:final.items.length,mappings:final.mappings.length,pending:final.items.filter(v=>!v.productVariantId).length,
    parentLearningMappings:final.mappings.filter(m=>m.method==='AUTO'&&m.myacgMainId).length,duplicates:0,quantityError:0,cutoverPreserved:true});
  mkdirSync('scratch/waca-resolver-v3',{recursive:true});writeFileSync('scratch/waca-resolver-v3/native-replay-summary.json',JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
} finally {await vite.close();await db.close();}
