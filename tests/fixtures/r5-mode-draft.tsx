// Real React hook + real DynamicDataProvider; only provider persistence is synthetic.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useProductGroupBasicInfoDrafts } from '../../src/hooks/useProductGroupBasicInfoDrafts';
import { dataProvider } from '../../src/providers/dataProvider';
import { LocalProvider } from '../../src/providers/localProvider';
import { supabaseProvider } from '../../src/providers/cloud/supabaseProvider';
import { markCloudReadFresh } from '../../src/providers/cloud/cloudConnectivity';
import { setProviderMode } from '../../src/providers/providerMode';
import { raiseCloudCacheEpochBarrier } from '../../src/providers/cloud/cloudCacheWriteFence';
const writes: string[] = [];
const group = {id:'10000000-0000-4000-8000-000000000001',title:'Synthetic draft',release_month:'base',created_at:'2026-01-01',updated_at:'2026-01-01'};
let resume: (()=>void) | undefined;
let hold=false;
const persist = async (mode: string) => {
  writes.push(mode);
  if(hold) await new Promise<void>(resolve=> { resume=resolve; });
};
LocalProvider.prototype.getProductGroups = async () => [group];
supabaseProvider.getProductGroups = async () => [group];
LocalProvider.prototype.saveProductGroups = async () => persist('local');
supabaseProvider.saveProductGroups = async () => persist('cloud');
await dataProvider.getProductGroups();
markCloudReadFresh(1);
Object.assign(window, {r5:{writes,switchMode:setProviderMode,epoch:()=>raiseCloudCacheEpochBarrier(),
  hold:()=>{hold=true;},release:()=>{hold=false;resume?.();},
  rawSave:()=>dataProvider.saveProductGroups([group])}});
function Form() {
  const draft=useProductGroupBasicInfoDrafts();
  const save=async (_id:string,_field:string,value:string) => {
    await dataProvider.saveProductGroups([{...group,release_month:value}]);return true;
  };
  return <><label>發售月份<input aria-label="發售月份" value={draft.valueOf(group,'release_month')}
    onChange={e=>draft.change(group,'release_month',e.target.value)}
    onBlur={()=>void draft.commit(group,'release_month','blur',save)}
    onKeyDown={e=>{if(e.key==='Escape')draft.cancel(group.id,'release_month');
      if(e.key==='Enter')void draft.commit(group,'release_month','enter',save);}}/></label>
    <button onClick={()=>draft.discardUnsaved()}>放棄</button>
    <p role="status">{draft.errorOf(group.id,'release_month') ?? (draft.hasDrafts ? '未儲存' : '無草稿')}</p></>;
}
createRoot(document.getElementById('root')!).render(<Form/>);
