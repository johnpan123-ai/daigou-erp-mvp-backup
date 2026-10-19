import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { recognitionDatabase } from './waca-recognition-isolated.mjs';
import { readUtf8Json } from './utf8-json-stream.mjs';
export async function recognitionPreview(port=4742) {
  const db=await recognitionDatabase();
  await db.importRows([db.row('DEMO-ORDER-001',2),db.row('DEMO-ORDER-001',3,'完成付款','G-SECOND'),db.row('DEMO-ORDER-002',1),db.row('DEMO-CANCELLED',1,'取消')]);
  const allowedTables=new Set([...Object.keys((await db.state()).business),'erp_cloud_restore_epoch']);
  const allowedRpc=new Set(['erp_read_waca_snapshot','erp_preview_waca_recognition','erp_commit_waca_recognition']);
  const calls=[];
  const vite=await createServer({configFile:false,mode:'staging',define:{
    'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://rhfdjsklfrgpoqsaqpkn.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('isolated-not-a-credential'),
    'import.meta.env.VITE_DEPLOYMENT_ENV':JSON.stringify('staging')},esbuild:{jsx:'automatic'},
    server:{host:'127.0.0.1',port,strictPort:true,hmr:false,headers:{'Content-Security-Policy':"connect-src 'self' ws://127.0.0.1:*"}},
    cacheDir:'.vite-cache/waca-recognition-preview',optimizeDeps:{include:['react','react-dom/client','react-router-dom','react/jsx-runtime','lucide-react','xlsx','@supabase/supabase-js']},
    plugins:[{name:'loopback-only-recognition-db',configureServer(server){
      server.middlewares.use('/__recognition_db',async(req,res)=>{
        try {
          assert.equal(req.method,'POST');if(req.headers.origin)assert.equal(req.headers.origin,`http://127.0.0.1:${port}`);
          const {path,body}=await readUtf8Json(req);
          if(path.startsWith('/rpc/'))assert.ok(allowedRpc.has(path.slice(5)));else assert.ok(allowedTables.has(path.slice(1).split('?')[0]));
          calls.push({path,at:new Date().toISOString()});
          const r=await db.rawHttp(path,body);if(r.status>=400)console.error('Isolated HTTP',path,JSON.stringify(r));res.setHeader('content-type','application/json');res.end(JSON.stringify(r));
        } catch(error) {console.error('Isolated route rejected:',error.message);res.statusCode=400;res.end(JSON.stringify({status:400,data:{message:'ISOLATED_ROUTE_REJECTED'}}));}
      });
    }}]});
  try {await vite.listen();}catch(error){await vite.close();await db.close();throw error;}
  return {db,calls,vite,url:`http://127.0.0.1:${port}/tests/fixtures/waca-recognition.html`,async close(){await vite.close();await db.close();}};
}
