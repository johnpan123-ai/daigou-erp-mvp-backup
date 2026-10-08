import { recordBuyAnimeCatalogEvidence } from '../../diagnostics/buyAnimeProductionTrace';

// Scheduling only: it neither grants write permission nor marks cache fresh.
// Realtime/focus/reconnect requests remain queued and run after RPC resolution.
const windows=new Set<Promise<void>>();
export function beginCatalogCommitReadFence():()=>void {
  let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  windows.add(pending);
  return ()=>{ windows.delete(pending); release(); };
}
export async function awaitCatalogCommitReadFence(caller:string, signal?:AbortSignal):Promise<void> {
  const started=performance.now();
  let deferred=false;
  while(windows.size) {
    signal?.throwIfAborted(); deferred=true;
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{cleanup();reject(signal?.reason ?? new DOMException('Aborted','AbortError'));};
      const cleanup=()=>signal?.removeEventListener('abort',abort);
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted) {abort();return;}
      Promise.all([...windows]).then(()=>{cleanup();resolve();},error=>{cleanup();reject(error);});
    });
  }
  signal?.throwIfAborted();
  if(deferred) recordBuyAnimeCatalogEvidence('inventory-read-deferred',{caller,elapsedMs:performance.now()-started});
}
