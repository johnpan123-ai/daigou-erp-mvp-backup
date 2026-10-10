import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { cloudCacheDb } from '../../src/lib/db';
import { dataProvider } from '../../src/providers/dataProvider';
import { AuthContext, type AuthContextType } from '../../src/auth/authContext';
import { CloudRealtimeSyncBoundary, useGlobalSyncControl } from '../../src/contexts/CloudRealtimeSyncContext';
import { installCloudRealtimeTestBridge } from '../../src/contexts/cloudRealtimeTestBridge';
import { coordinateBuyAnimeImport, refreshBuyAnimeReadback, publishBuyAnimeFlow } from '../../src/providers/cloud/buyAnimeImportCoordinator';
import { markCloudReadFresh } from '../../src/providers/cloud/cloudConnectivity';
import Inventory from '../../src/pages/Inventory';
import type { BuyAnimeImportRecord } from '../../src/providers/cloud/buyAnimeImportResume';
import { ViewportProvider } from '../../src/contexts/ViewportContext';
import '../../src/index.css';

// Isolated UI dependency seam: real page/context/cache; no production requests.
const nativeFetch = window.fetch.bind(window);
let externalRequests = 0;
window.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.origin !== location.origin) { externalRequests++; throw new Error('ISOLATED_EXTERNAL_REQUEST_DENIED'); }
  return nativeFetch(input, init);
};
localStorage.setItem('erp_provider_mode', 'experimental');
installCloudRealtimeTestBridge({ query: async () => [], attach: () => {} });
localStorage.setItem('erp_provider_mode', 'cloud');
const id = '10000000-0000-4000-8000-000000000001';
let server = { id, version: 1, inventory_key: 'G-NOF5', myacg_item_code: 'G-NOF5', product_title: 'Hololive No-F5 Isolated',
  normalized_product_title: 'Hololive No-F5 Isolated', raw_variant_name: '壓克力立牌', listing_type: '日本代購', final_price: 100,
  myacg_available_quantity: 0, myacg_sold_quantity: 14, myacg_listed_at: '', updated_at: '2026-10-10T00:00:00.000Z' };
await cloudCacheDb.saveInventory([server]);
await cloudCacheDb.saveProductGroups([]);
await cloudCacheDb.replaceProductVariantsFromAuthoritativeCloud([]);
const empty = async () => [];
dataProvider.getProductGroups = empty;
dataProvider.getProductVariants = empty;
dataProvider.getInventory = () => cloudCacheDb.getInventory();
dataProvider.getInventoryCatalogSnapshot = async () => ({ inventory: await cloudCacheDb.getInventory(), productGroups: [] });
dataProvider.waitForCloudBootstrapConvergence = async () => false;
dataProvider.getLastImportBackup = async () => null;
dataProvider.getBuyAnimeImportRecovery = async () => null;
dataProvider.recoverPendingBuyAnimeImport = async () => null;
let release: (() => void) | undefined;
let observed = '';
async function scenario() {
  await coordinateBuyAnimeImport(async () => {
    server = { ...server, version: server.version + 1, myacg_sold_quantity: 20 };
    // Hold after simulated authoritative commit; observe Sync before UI ACK.
    await new Promise<void>(resolve => { release = resolve; });
    await refreshBuyAnimeReadback({ changes: [{ table: 'inventory_items', resource: 'inventory', kind: 'UPDATE',
      canonicalId: id, databaseId: id, localId: null, origin: 'remote' }], rowsByTable: { inventory_items: [server] } },
      async () => { throw new Error('TARGETED_BOUNDARY_REQUIRED'); });
    observed = document.body.innerText;
    publishBuyAnimeFlow('匯入完成');
  });
}
dataProvider.completeBuyAnimeImport = async (rows,fileName) => {
  await scenario();
  return { format:'BUYANIME_IMPORT_RESUME_V1',batchId:rows[0].latest_catalog_import_id!,observedAt:rows[0].catalog_last_seen_at!,
    fileName,stage:'COMPLETE',version:1,expected:[],stats:{total:1,newCount:0,updatedCount:1,unchangedCount:0,groupCount:1} } as BuyAnimeImportRecord;
};
const auth = {user:{id:'00000000-0000-4000-8000-000000000001'},profile:{role:'owner',display_name:'Isolated',is_active:true},loading:false,profileLoading:false,authFlow:'normal'} as AuthContextType;
export function Controls() {
  const { presentation } = useGlobalSyncControl();
  const [result,setResult] = useState('NOT RUN');
  return <section><h1>Isolated No-F5 UI Gate</h1><p data-testid="sync">{presentation.label}</p>
    <button onClick={() => {setResult('IMPORT ACTIVE');void scenario().then(()=>setResult('SUCCESS — Cloud 20 / Targeted React ACK complete')).catch(e=>setResult(String(e)));}}>Start isolated commit</button>
    <button onClick={() => release?.()}>Release authoritative refresh</button>
    <pre data-testid="result">{result}</pre><pre data-testid="ack">{result.startsWith('SUCCESS') ? JSON.stringify({externalRequests, quantity20PresentBeforeReturn: observed.includes('20')}) : ''}</pre>
    <Inventory />
  </section>;
}
markCloudReadFresh();
createRoot(document.getElementById('root')!).render(<AuthContext.Provider value={auth}><ViewportProvider><CloudRealtimeSyncBoundary><Controls /></CloudRealtimeSyncBoundary></ViewportProvider></AuthContext.Provider>);
