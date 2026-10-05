// Only served by the isolated native test. No credentials or production network.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import '/src/index.css';
localStorage.setItem('erp_provider_mode','experimental');
const [{installCloudRealtimeTestBridge},{supabase},{AuthContext},{ViewportProvider},{AppLayout},
 {CloudRealtimeSyncBoundary,useGlobalSyncControl},{default:Waca},{markCloudReadFresh}] = await Promise.all([
 import('/src/contexts/cloudRealtimeTestBridge.ts'),import('/src/providers/cloud/supabaseClient.ts'),
 import('/src/auth/authContext.ts'),import('/src/contexts/ViewportContext.tsx'),import('/src/components/layout/AppLayout.tsx'),
 import('/src/contexts/CloudRealtimeSyncContext.tsx'),import('/src/pages/WacaIntegration.tsx'),
 import('/src/providers/cloud/cloudConnectivity.ts')]);
const timings={}; const calls={backup:0,commit:0};
async function transport(path,body) {
 const start=performance.now();
 if(/export_cloud_restore|backup/i.test(path)){calls.backup++;throw new Error('FULL_BACKUP_FORBIDDEN');}
 const key=path.includes('/rpc/erp_commit')?'commit':path.includes('/rpc/erp_read_waca')?'snapshot':'readbackAndRefresh';
 if(key==='commit')calls.commit++;
 try{return await fetch('/__waca_isolated',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path,body})}).then(r=>r.json());}
 finally{timings[key]=(timings[key]||0)+performance.now()-start;}
}
const tableRead=async(table,from=0,to=999,ids,active=false)=>{
 const q=new URLSearchParams({select:'*',order:'id',offset:String(from),limit:String(to-from+1)});
 if(ids)q.set('id',`in.(${ids.join(',')})`);
 if(active)q.set('deleted_at','is.null');
 const r=await transport('/'+table+'?'+q);if(r.status!==200)throw r.data;return r.data;
};
installCloudRealtimeTestBridge({query:({table,from,to,databaseIds})=>tableRead(table,from,to,databaseIds),attach(){}});
localStorage.setItem('erp_provider_mode','cloud');
const user={id:'00000000-0000-4000-8000-000000000099',email:'isolated@example.invalid',app_metadata:{},user_metadata:{},aud:'authenticated',role:'authenticated',created_at:''};
supabase.auth.getSession=async()=>({data:{session:{user}},error:null});
supabase.from=table=>{
 let active=false;
 const builder={select(){return builder;},is(key,value){if(key==='deleted_at'&&value===null)active=true;return builder;},order(){return builder;},eq(){return builder;},limit(){return builder;},
  async single(){if(table!=='profiles')throw new Error('UNEXPECTED_SINGLE');return {data:{role:'owner',is_active:true},error:null};},
  async range(from,to){try{return {data:await tableRead(table,from,to,undefined,active),error:null};}catch(error){return {data:null,error};}}};return builder;
};
supabase.rpc=async(name,args)=>{const r=await transport('/rpc/'+name,args??{});return r.status===200?{data:r.data,error:null}:{data:null,error:r.data};};
markCloudReadFresh();
function Status(){const s=useGlobalSyncControl();return React.createElement('output',{'data-testid':'actual-global-sync'},s.presentation.status);}
window.wacaAtomicTest={reset(){for(const k of Object.keys(timings))delete timings[k];calls.commit=0;calls.backup=0;},metrics(){return {timings:{...timings},calls:{...calls}};}};
const auth={user,profile:{role:'owner',display_name:'Isolated owner',is_active:true},loading:false,profileLoading:false,authFlow:'normal',signOut:async()=>{}};
createRoot(document.getElementById('root')).render(React.createElement(AuthContext.Provider,{value:auth},
 React.createElement(ViewportProvider,null,React.createElement(BrowserRouter,null,React.createElement(CloudRealtimeSyncBoundary,null,
 React.createElement(Status),React.createElement(AppLayout,null,React.createElement(Waca)))))));
