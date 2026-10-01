// Only imported by a disposable loopback test entry point, never application code.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter,Routes,Route} from 'react-router-dom';
import '/src/index.css';
if(location.hostname!=='127.0.0.1'||location.port!=='4401')throw new Error('DISPOSABLE_UI_ORIGIN_REQUIRED');
localStorage.setItem('erp_provider_mode','cloud');
localStorage.setItem('purchase_management_edit_mode','true');
const [{supabase},{AuthContext},{ViewportProvider},{AppLayout},{default:PurchaseManagement},{default:Inventory},{default:Settings}]=await Promise.all([
  import('/src/providers/cloud/supabaseClient.ts'),import('/src/auth/authContext.ts'),import('/src/contexts/ViewportContext.tsx'),
  import('/src/components/layout/AppLayout.tsx'),import('/src/pages/PurchaseManagement.tsx'),import('/src/pages/Inventory.tsx'),import('/src/pages/Settings.tsx'),
]);
const user={id:'00000000-0000-4000-8000-000000000099',email:'synthetic@example.invalid',app_metadata:{},user_metadata:{}};
supabase.auth.getSession=async()=>({data:{session:{user}},error:null});
let loseNext=false;let readFailure=false;const calls=[];
const request=async(path,body)=>{
  const response=await fetch('http://127.0.0.1:4403'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();return response.ok?{data,error:null}:{data:null,error:data};
};
supabase.from=table=>{
  const query=new URLSearchParams();
  const builder={
    select(fields='*'){query.set('select',fields);return builder;},is(field,val){query.set(field,'is.'+val);return builder;},
    eq(field,val){query.set(field,'eq.'+val);return builder;},order(field){query.set('order',field);return builder;},
    in(field,ids){query.set(field,'in.('+ids.join(',')+')');return builder;},gt(field,val){query.set(field,'gt.'+val);return builder;},
    range(from,to){query.set('offset',from);query.set('limit',to-from+1);return builder;},limit(n){query.set('limit',n);return builder;},abortSignal(){return builder;},
    async single(){const r=await request('/'+table+'?'+query);return {...r,data:r.data?.[0]??null};},
    then(resolve,reject){
      if(readFailure && table==='private_order_items'){readFailure=false;return Promise.resolve({data:null,error:{code:'XX001',message:'Synthetic read failure'}}).then(resolve,reject);}
      return request('/'+table+'?'+query).then(resolve,reject);
    },
    upsert(){throw new Error('RAW_WRITE_FORBIDDEN');},insert(){throw new Error('RAW_WRITE_FORBIDDEN');},update(){throw new Error('RAW_WRITE_FORBIDDEN');},delete(){throw new Error('RAW_WRITE_FORBIDDEN');},
  };return builder;
};
supabase.rpc=async(name,body)=>{
  calls.push({name,key:body?.p_idempotency_key});
  const r=await request('/rpc/'+name,body??{});
  if(loseNext && r.data?.ok){loseNext=false;throw new Error('Synthetic response loss AFTER server commit');}
  return r;
};
window.saveabilityFixture={loseNext(){loseNext=true;},failRead(){readFailure=true;},calls:()=>structuredClone(calls)};
const {markCloudReadFresh}=await import('/src/providers/cloud/cloudConnectivity.ts');
markCloudReadFresh(1);
const mode=new URLSearchParams(location.search).get('view')??'private';
const route=mode==='catalog'?'/inventory':mode==='settings'?'/settings':'/purchase-records/10000000-0000-4000-8000-000000000001';
history.replaceState(null,'',route+location.search);
const auth={user,profile:{role:'owner',display_name:'Synthetic owner',is_active:true},loading:false,profileLoading:false,authFlow:'normal',signOut:async()=>{},signInWithPassword:async()=>{},requestPasswordReset:async()=>{},setNewPassword:async()=>{}};
createRoot(document.getElementById('root')).render(React.createElement(AuthContext.Provider,{value:auth},React.createElement(ViewportProvider,null,
  React.createElement(BrowserRouter,null,React.createElement(AppLayout,null,React.createElement(Routes,null,
    React.createElement(Route,{path:mode==='private'?'/purchase-records/:id':route,element:React.createElement(mode==='catalog'?Inventory:mode==='settings'?Settings:PurchaseManagement)})))))));
