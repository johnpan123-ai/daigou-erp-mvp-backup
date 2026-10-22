// Preview-only transport: real Cloud provider + real native PostgreSQL RPCs.
// Auth and Realtime notifications are synthetic. No production network is allowed.
const nativeFetch=window.fetch.bind(window);
window.fetch=(input,init)=>{
  const request=input instanceof Request?input:null;
  const url=new URL(request?.url||String(input),location.origin);
  if(url.origin===location.origin)return nativeFetch(input,init);
  if(url.origin==='https://rhfdjsklfrgpoqsaqpkn.supabase.co'&&url.pathname.startsWith('/rest/v1/')){
    return nativeFetch('/__r5/rest/'+url.pathname.slice('/rest/v1/'.length)+url.search,{...init,method:init?.method||request?.method,headers:init?.headers||request?.headers,body:init?.body});
  }
  return Promise.reject(new Error('隔離預覽禁止外部連線'));
};
if(!['cloud','local'].includes(localStorage.getItem('erp_provider_mode')))localStorage.setItem('erp_provider_mode','cloud');
const mode=await import('/src/providers/providerMode.ts');
if(mode.getProviderMode()==='local')mode.markManualLocalEntry();
const {supabase}=await import('/src/providers/cloud/supabaseClient.ts');
const session={user:{id:'00000000-0000-4000-8000-000000000099',email:'isolated-owner@example.invalid'}};
supabase.auth.getSession=async()=>({data:{session},error:null});
supabase.auth.onAuthStateChange=callback=>{const timer=setTimeout(()=>callback('INITIAL_SESSION',session),0);return {data:{subscription:{unsubscribe(){clearTimeout(timer);}}}};};
const channels=[];
supabase.channel=topic=>{
  const handlers=[];const channel={topic:'realtime:'+topic,on(type,filter,callback){handlers.push({type,filter,callback});return channel;},subscribe(callback){setTimeout(()=>{callback('SUBSCRIBED');handlers.filter(h=>h.type==='system').forEach(h=>h.callback({extension:'postgres_changes',status:'ok'}));},0);return channel;},unsubscribe:async()=> 'ok'};
  channels.push(channel);return channel;
};
supabase.getChannels=()=>channels;
supabase.removeChannel=async channel=>{const i=channels.indexOf(channel);if(i>=0)channels.splice(i,1);return 'ok';};
// Start Cloud deep links from the normal list bootstrap, then navigate only after it earns Fresh.
// This preview does not mark Fresh or relax any production readiness/write guard.
const requestedRoute=location.pathname+location.search;
const deferRoute=mode.getProviderMode()==='cloud'&&location.pathname!=='/purchase-records';
if(deferRoute)history.replaceState({},'','/purchase-records');
if(mode.getProviderMode()==='local'){
  // Independently authored Local sample, never copied from the Cloud cache.
  const {localDb}=await import('/src/lib/db.ts');
  if((await localDb.getProductGroups()).length===0)await localDb.saveProductGroups([{id:'10000000-0000-4000-8000-000000000001',title:'Local 獨立日期示範商品',show_in_purchase_list:true,closing_date:'2026/10/25',created_at:'2026-10-22',updated_at:'2026-10-22'}]);
}
const React=await import('react');const {createRoot}=await import('react-dom/client');
await import('/src/index.css');const {default:App}=await import('/src/App.tsx');
const tools=document.getElementById('preview-tools');
tools.style.cssText='position:sticky;top:0;z-index:99999;background:#eff6ff;border-bottom:2px solid #3b82f6;padding:10px 16px;font:14px sans-serif;display:flex;gap:12px;flex-wrap:wrap;align-items:center';
const title=document.createElement('strong');title.textContent='R5 隔離預覽｜示範資料，可操作保存，不連線正式 ERP';tools.append(title);
for(const [label,path] of [['訂購表 L1','/purchase-records'],['商品詳情 L2','/purchase-records/10000000-0000-4000-8000-000000000001'],['包裹點收','/japan-packages/10000000-0000-4000-8000-000000000301'],['出庫單 A','/outbound-shipments/10000000-0000-4000-8000-000000000310'],['出庫單 B','/outbound-shipments/10000000-0000-4000-8000-000000000311']]){const a=document.createElement('a');a.textContent=label;a.href=path;a.onclick=e=>{e.preventDefault();history.pushState({},'',path);dispatchEvent(new PopStateEvent('popstate'));};tools.append(a);}
for(const [label,value] of [['切換 Cloud 示範','cloud'],['切換 Local 示範','local']]){const b=document.createElement('button');b.textContent=label;b.onmousedown=e=>e.preventDefault();b.onclick=()=>{if(value==='local')mode.markManualLocalEntry();mode.setProviderMode(value);};tools.append(b);}
const reload=document.createElement('button');reload.textContent='放棄草稿並重新載入';reload.onmousedown=e=>e.preventDefault();reload.onclick=()=>location.reload();tools.append(reload);
const note=document.createElement('small');note.textContent='Cloud 使用隔離 PostgreSQL；Local 使用此網址的獨立本機資料。即時通知為示範，其他分頁修改後請重新載入。';tools.append(note);
createRoot(document.getElementById('root')).render(React.createElement(App));
if(deferRoute){
  const connectivity=await import('/src/providers/cloud/cloudConnectivity.ts');let navigating=false;
  const restore=()=>{if(navigating||!connectivity.getCloudConnectivitySnapshot().readStatus.startsWith('fresh-'))return;navigating=true;setTimeout(()=>{unsubscribe();history.replaceState({},'',requestedRoute);dispatchEvent(new PopStateEvent('popstate'));},0);};
  const unsubscribe=connectivity.subscribeCloudConnectivity(restore);restore();
}
