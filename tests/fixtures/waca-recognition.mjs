// Test entry only: real React / Provider / GlobalSync -> local authenticated
// PostgREST -> disposable native PostgreSQL with safeupdate. No cloud secrets.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import '/src/index.css';
localStorage.setItem('erp_provider_mode','experimental');
const [{installCloudRealtimeTestBridge},{supabase},{AuthContext},{ViewportProvider},{AppLayout},
  {CloudRealtimeSyncBoundary,useGlobalSyncControl},{default:Waca},{markCloudReadFresh}]=await Promise.all([
  import('/src/contexts/cloudRealtimeTestBridge.ts'),import('/src/providers/cloud/supabaseClient.ts'),
  import('/src/auth/authContext.ts'),import('/src/contexts/ViewportContext.tsx'),import('/src/components/layout/AppLayout.tsx'),
  import('/src/contexts/CloudRealtimeSyncContext.tsx'),import('/src/pages/WacaIntegration.tsx'),import('/src/providers/cloud/cloudConnectivity.ts')]);
const role=new URLSearchParams(location.search).get('role')==='viewer'?'viewer':'owner';
const transport=async(path,body)=>fetch('/__recognition_db',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path,body})}).then(r=>r.json());
const tableRead=async(table,from=0,to=999,ids,active=false)=>{
  const query=new URLSearchParams({select:'*',order:table==='erp_cloud_restore_epoch'?'singleton':'id',offset:String(from),limit:String(to-from+1)});
  if(ids)query.set('id',`in.(${ids.join(',')})`);if(active)query.set('deleted_at','is.null');
  const r=await transport('/'+table+'?'+query);if(r.status!==200)throw r.data;return r.data;
};
installCloudRealtimeTestBridge({query:({table,from,to,databaseIds})=>tableRead(table,from,to,databaseIds),attach(){}});
localStorage.setItem('erp_provider_mode','cloud');
const user={id:'00000000-0000-4000-8000-000000000099',email:'isolated@example.invalid',app_metadata:{},user_metadata:{},aud:'authenticated',role:'authenticated',created_at:''};
supabase.auth.getSession=async()=>({data:{session:{user}},error:null});
supabase.from=table=>{
  let active=false;
  const builder={select(){return builder;},is(k,v){if(k==='deleted_at'&&v===null)active=true;return builder;},order(){return builder;},eq(){return builder;},limit(){return builder;},
    async single(){if(table==='profiles')return {data:{role,is_active:true},error:null};
      if(table==='erp_cloud_restore_epoch')return {data:(await tableRead(table))[0],error:null};throw new Error('UNEXPECTED_SINGLE');},
    async range(from,to){try{return {data:await tableRead(table,from,to,undefined,active),error:null};}catch(error){return {data:null,error};}}};return builder;
};
supabase.rpc=async(name,args)=>{const r=await transport('/rpc/'+name,args??{});return r.status===200?{data:r.data,error:null}:{data:null,error:r.data};};
markCloudReadFresh();
function Status(){const s=useGlobalSyncControl();return React.createElement('output',{'data-testid':'actual-global-sync'},s.presentation.status);}
const auth={user,profile:{role,display_name:'Isolated Owner',is_active:true},loading:false,profileLoading:false,authFlow:'normal',signOut:async()=>{}};
createRoot(document.getElementById('root')).render(React.createElement(AuthContext.Provider,{value:auth},
  React.createElement(ViewportProvider,null,React.createElement(BrowserRouter,null,React.createElement(CloudRealtimeSyncBoundary,null,
    React.createElement('p',{role:'note',style:{margin:0,padding:'10px 20px',background:'#dbeafe',color:'#1e40af'}},
      '隔離預覽：合成訂單 → 真實本機 PostgreSQL／PostgREST（safeupdate 開啟）。不連線、不寫入正式 ERP。'),
    React.createElement(Status),React.createElement(AppLayout,null,React.createElement(Waca)))))));
