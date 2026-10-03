import { createClient } from '@supabase/supabase-js';
import { supabase } from '../../src/providers/cloud/supabaseClient';
import { SupabaseProvider } from '../../src/providers/cloud/supabaseProvider';
import { markCloudReadFresh } from '../../src/providers/cloud/cloudConnectivity';
import { parseMyAcgFile } from '../../src/utils/myacgParser';
import type { BuyAnimeImportRecord } from '../../src/providers/cloud/buyAnimeImportResume';

declare global {
  interface Window {
    __BUYANIME_ISOLATED_HTTP__: (request: { path: string; method: string; body?: unknown; prefer?: string; accept?: string }) => Promise<{status:number;data:unknown}>;
    __BUYANIME_RESUME_PROVIDER__: {
      setup: (actor: string) => void;
      parse: (base64: string) => ReturnType<typeof parseMyAcgFile>;
      provider: () => SupabaseProvider;
      fresh: () => void;
      loseReadback: (enabled: boolean) => void;
      loseCatalog: (enabled: boolean) => void;
      loseWaca: (enabled: boolean) => void;
      metrics: () => { inventoryCommits:number;catalogRequests:number;wacaRequests:number;readQueries:number;maxUrlBytes:number;largestChunkLatencyMs:number; totalRequests:number; fullReads:number; fullSnapshotReads:number; readMs:number };
      failReadbackRequests: (count: number) => void;
      lastRecord?: BuyAnimeImportRecord;
    };
  }
}
let readbackLost = false, catalogLost = false, wacaLost = false;
let remainingReadFailures = 0;
const metrics = { inventoryCommits:0,catalogRequests:0,wacaRequests:0,readQueries:0,maxUrlBytes:0,largestChunkLatencyMs:0,totalRequests:0,fullReads:0,fullSnapshotReads:0,readMs:0 };
window.__BUYANIME_RESUME_PROVIDER__ = {
  setup(actor) {
    const isolated = createClient('http://127.0.0.1:4399','ephemeral-isolated-public-placeholder', {
      auth: { persistSession:false,autoRefreshToken:false,detectSessionInUrl:false },
      global: { fetch: async (input,init) => {
        const url=new URL(String(input));
        if(url.origin!=='http://127.0.0.1:4399')throw new Error('ISOLATED_HOST_REQUIRED');
        const path=url.pathname+url.search;
        const method=String(init?.method||'GET');
        const started=performance.now();
        metrics.totalRequests++;
        if(method==='GET' && !url.searchParams.has('id')) metrics.fullReads++;
        if(method==='GET' && url.searchParams.get('select')==='*' && !url.searchParams.has('id')
          && !url.searchParams.has('product_group_id') && !url.searchParams.has('product_category_id')) metrics.fullSnapshotReads++;
        const body=typeof init?.body==='string'?JSON.parse(init.body):undefined;
        if(method==='GET' && url.searchParams.has('id') && url.searchParams.get('id')?.startsWith('in.')){
          metrics.readQueries++;metrics.maxUrlBytes=Math.max(metrics.maxUrlBytes,new TextEncoder().encode(url.href).length);
          if(readbackLost)throw new TypeError('Failed to fetch: isolated readback transport failure');
          if(url.pathname.endsWith('/inventory_items') && remainingReadFailures>0) {
            remainingReadFailures--;throw new TypeError('Failed to fetch: isolated transient readback failure');
          }
        }
        if(url.pathname==='/rest/v1/rpc/erp_apply_field_mutations')metrics.inventoryCommits++;
        if(url.pathname==='/rest/v1/rpc/erp_apply_catalog_transaction')metrics.catalogRequests++;
        if(url.pathname==='/rest/v1/rpc/erp_commit_waca_snapshot')metrics.wacaRequests++;
        const result=await window.__BUYANIME_ISOLATED_HTTP__({
          path:path.replace(/^\/rest\/v1/u,''),method,body,prefer:new Headers(init?.headers).get('prefer')||undefined,
          accept:new Headers(init?.headers).get('accept')||undefined,
        });
        if(method==='GET') metrics.readMs+=performance.now()-started;
        if(method==='GET' && url.searchParams.get('id')?.startsWith('in.'))
          metrics.largestChunkLatencyMs=Math.max(metrics.largestChunkLatencyMs,performance.now()-started);
        if(result.status===200 && url.pathname==='/rest/v1/rpc/erp_apply_catalog_transaction' && catalogLost){
          catalogLost=false;throw new TypeError('Failed to fetch: isolated Catalog response lost after commit');
        }
        if(result.status===200 && url.pathname==='/rest/v1/rpc/erp_commit_waca_snapshot' && wacaLost){
          wacaLost=false;throw new TypeError('Failed to fetch: isolated WACA response lost after commit');
        }
        return new Response(result.status===204?null:JSON.stringify(result.data),{
          status:result.status,headers:{'content-type':'application/json'},
        });
      } },
    });
    supabase.from=isolated.from.bind(isolated);
    supabase.rpc=isolated.rpc.bind(isolated);
    supabase.auth.getSession=async()=>({data:{session:{user:{id:actor}}},error:null}) as Awaited<ReturnType<typeof supabase.auth.getSession>>;
    markCloudReadFresh(1);
  },
  parse: base64 => parseMyAcgFile(new File([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],'399375_2026-10-03.xls')),
  provider: () => new SupabaseProvider(),
  fresh: () => markCloudReadFresh(1),
  loseReadback: enabled => {readbackLost=enabled;},
  failReadbackRequests: count => {remainingReadFailures=count;},
  loseCatalog: enabled => {catalogLost=enabled;},
  loseWaca: enabled => {wacaLost=enabled;},
  metrics: () => ({...metrics}),
};
