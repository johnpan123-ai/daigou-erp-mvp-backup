import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import Inventory from '../../src/pages/Inventory';
import { ViewportProvider } from '../../src/contexts/ViewportContext';
import { dataProvider } from '../../src/providers/dataProvider';
import type { SupabaseProvider } from '../../src/providers/cloud/supabaseProvider';

export async function renderReadOnlyUi(provider: SupabaseProvider) {
  dataProvider.getInventoryCatalogSnapshot = provider.getInventoryCatalogSnapshot.bind(provider);
  dataProvider.getInventory = provider.getInventory.bind(provider);
  dataProvider.getProductGroups = provider.getProductGroups.bind(provider);
  dataProvider.getLastImportBackup = provider.getLastImportBackup.bind(provider);
  dataProvider.getBuyAnimeImportRecovery = provider.getBuyAnimeImportRecovery.bind(provider);
  dataProvider.waitForCloudBootstrapConvergence = async () => false;
  const node = document.createElement('div'); document.body.appendChild(node);
  const root = createRoot(node), durations: number[] = [];
  try {
    root.render(<Profiler id="Inventory" onRender={(_id, _phase, duration) => durations.push(Math.round(duration))}>
      <ViewportProvider><Inventory /></ViewportProvider>
    </Profiler>);
    const deadline = performance.now() + 10000;
    while (!node.innerText.includes('商品總數') || node.innerText.includes('載入中')) {
      if (performance.now() > deadline) throw new Error('ISOLATED_UI_RENDER_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { commits: durations.length, maxDurationMs: Math.max(0, ...durations) };
  } finally { root.unmount(); node.remove(); }
}
