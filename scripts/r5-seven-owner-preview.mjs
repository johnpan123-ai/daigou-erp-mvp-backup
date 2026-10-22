// Persistent loopback-only Owner preview with a disposable native database.
import {readFileSync} from 'node:fs';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {isolatedDatabase,uuid,owner} from '../tests/helpers/saveability-isolated.mjs';
process.env.WACA_ISOLATED_PG_URL='postgresql://postgres@127.0.0.1:55492/waca_v3_base';
process.env.WACA_TEST_POSTGREST_PORT=process.env.R5_PREVIEW_POSTGREST_PORT||'4499';
const port=Number(process.env.R5_PREVIEW_PORT||4792);if(![4792,4793].includes(port))throw Error('PREVIEW_LOOPBACK_PORT_REQUIRED');
const db=await isolatedDatabase({safeupdateLibrary:'/tmp/erp2-waca-21000-safeupdate.k8oEUd/safeupdate.so',postgrestBinary:'/tmp/erp2-waca-074-postgrest.5dmHGR/postgrest'});
let vite;
try{
 await db.sql.query(readFileSync('supabase/sql/078_core_source_capacity_and_receiving.sql','utf8'));
 await db.sql.query("update public.product_groups set title='R5 日期與來源示範商品',show_in_purchase_list=true,closing_date='2026/10/25' where id=$1",[uuid(1)]);
 await db.sql.query("insert into public.japan_packages(id,title,status) values($1,'R5 部分點收＋出庫保護示範','registered')",[uuid(301)]);
 await db.sql.query("insert into public.japan_package_items(id,japan_package_id,product_variant_id,sku,product_title,variant_name,quantity,checked,checked_at) values($1,$4,$5,'G-SYNTHETIC','已點收來源 5 件','已點收來源',5,true,'2026-10-20T01:00:00Z'),($2,$4,$5,'G-SYNTHETIC','來源 B 2 件','來源 B',2,false,null),($3,$4,$5,'G-SYNTHETIC','另一來源 3 件','另一來源',3,false,null)",[uuid(302),uuid(303),uuid(304),uuid(301),uuid(2)]);
 await db.sql.query("insert into public.outbound_shipments(id,title,status) values($1,'R5 出庫單 A','draft'),($2,'R5 出庫單 B','draft')",[uuid(310),uuid(311)]);
 await db.sql.query("insert into public.outbound_shipment_items(id,outbound_shipment_id,japan_package_item_id,product_variant_id,sku,product_title,quantity,checked) values($1,$2,$3,$4,'G-SYNTHETIC','已配置來源 3 件',3,false)",[uuid(312),uuid(310),uuid(302),uuid(2)]);
 await db.startPostgrest();
 const plugin={name:'r5-isolated-preview',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  res.setHeader('Content-Security-Policy',"default-src 'self' data:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data: blob:");
  if(req.url.startsWith('/__r5/rest/')){
   if(req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${port}`){res.statusCode=403;res.end();return;}
   try{let body='';for await(const bytes of req){body+=bytes;if(body.length>2*1024*1024)throw Error('PREVIEW_BODY_LIMIT');}
    const headers={host:'rhfdjsklfrgpoqsaqpkn.supabase.co'};for(const name of ['accept','prefer','range','range-unit'])if(req.headers[name])headers[name]=req.headers[name];
    const r=await db.http('/'+req.url.slice('/__r5/rest/'.length),body?JSON.parse(body):undefined,owner,{method:req.method,headers});
    res.statusCode=r.status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(r.data));
   }catch(error){res.statusCode=500;res.end(JSON.stringify({message:error.message}));}return;
  }
  if((req.headers.accept||'').includes('text/html')&&!req.url.startsWith('/tests/')&&!req.url.startsWith('/src/'))req.url='/tests/fixtures/r5-owner-preview.html';
  next();
 });}};
 vite=await createServer({configFile:false,plugins:[react(),plugin],server:{host:'127.0.0.1',port,strictPort:true,hmr:false},define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://rhfdjsklfrgpoqsaqpkn.supabase.co'),'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('isolated-preview-no-real-credential'),'import.meta.env.VITE_DEPLOYMENT_ENV':JSON.stringify('staging'),'import.meta.env.VITE_CLOUD_REALTIME_PREVIEW':JSON.stringify('true')}});
 await vite.listen();
 console.log(JSON.stringify({result:'READY',url:`http://127.0.0.1:${port}/purchase-records`,engine:'native PostgreSQL + PostgREST + safeupdate + 078 candidate',database:db.url.pathname.slice(1),auth:'synthetic Owner',realtime:'synthetic readiness; no remote WebSocket',formalWrites:0}));
 let closing=false;const close=async()=>{if(closing)return;closing=true;await vite.close();await db.close();process.exit(0);};process.once('SIGTERM',close);process.once('SIGINT',close);
 process.stdin.on('data',bytes=>{if(String(bytes).trim()==='close')void close();});
}catch(error){await vite?.close();await db.close();throw error;}
