import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import Inventory from '../../src/pages/Inventory';
import { ViewportProvider } from '../../src/contexts/ViewportContext';
import { CloudRealtimeSyncBoundary } from '../../src/contexts/CloudRealtimeSyncContext';
import { installCloudRealtimeTestBridge } from '../../src/contexts/cloudRealtimeTestBridge';
import { GlobalSyncControl } from '../../src/components/layout/GlobalSyncControl';
import { AuthContext } from '../../src/auth/authContext';
import { TEST_OWNER_PROFILE, TEST_OWNER_USER } from '../../src/auth/testOwner';
import { dataProvider } from '../../src/providers/dataProvider';
import { setProviderMode } from '../../src/providers/providerMode';
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

const bindProviderForImport = (provider: SupabaseProvider) => {
  const methods = [
    'getInventoryCatalogSnapshot',
    'getInventory',
    'getProductGroups',
    'getProductCategories',
    'getProductVariants',
    'getSalesOrders',
    'getSalesOrderItems',
    'getPurchaseBatches',
    'getPurchaseBatchItems',
    'getPrivateOrders',
    'getPrivateOrderItems',
    'getImportBatches',
    'getBundleComponents',
    'getJapanPackages',
    'getJapanPackageItems',
    'getOutboundShipments',
    'getOutboundShipmentItems',
    'getLastImportBackup',
    'saveLastImportBackup',
    'getBuyAnimeImportRecovery',
    'waitForCloudBootstrapConvergence',
    'completeBuyAnimeImport',
  ] as const;
  for (const method of methods) {
    const implementation = provider[method];
    if (typeof implementation !== 'function') throw new Error(`ISOLATED_PROVIDER_METHOD_MISSING:${method}`);
    Object.assign(dataProvider, { [method]: implementation.bind(provider) });
  }
};

const waitUntil = async (condition: () => boolean, code: string, timeoutMs = 30_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(code);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

/**
 * Starts the clock at the real file-input change and stops only when the
 * success dialog is visible while the shared Global Sync state is fresh.
 */
export async function renderImportBenchmarkUi(provider: SupabaseProvider, base64: string) {
  bindProviderForImport(provider);
  setProviderMode('experimental');
  let controllerAttached = false;
  const uninstallBridge = installCloudRealtimeTestBridge({
    query: async () => { throw new Error('UNEXPECTED_TARGETED_REFETCH'); },
    attach: () => { controllerAttached = true; },
  });
  setProviderMode('cloud');

  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  const durations: number[] = [];
  const auth = {
    user: TEST_OWNER_USER,
    profile: TEST_OWNER_PROFILE,
    loading: false,
    profileLoading: false,
    authFlow: 'normal' as const,
    signInWithPassword: async () => undefined,
    requestPasswordReset: async () => undefined,
    setNewPassword: async () => undefined,
    signOut: async () => undefined,
  };
  try {
    root.render(
      <AuthContext.Provider value={auth}>
        <CloudRealtimeSyncBoundary>
          <GlobalSyncControl />
          <Profiler id="Inventory" onRender={(_id, _phase, duration) => durations.push(Math.round(duration))}>
            <ViewportProvider><Inventory /></ViewportProvider>
          </Profiler>
        </CloudRealtimeSyncBoundary>
      </AuthContext.Provider>,
    );
    await waitUntil(
      () => Boolean(node.querySelector<HTMLInputElement>('input[type="file"]'))
        && node.innerText.includes('商品總數') && !node.innerText.includes('載入中') && controllerAttached,
      'ISOLATED_IMPORT_UI_BOOTSTRAP_TIMEOUT',
    );
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], '399375_2026-10-03.xls', { type: 'application/vnd.ms-excel' }));
    const input = node.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('ISOLATED_IMPORT_FILE_INPUT_MISSING');
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });

    const startedAt = performance.now();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitUntil(() => {
      const modal = node.querySelector('[data-testid="buyanime-import-success-modal"]');
      const sync = node.querySelector('[data-global-sync-control]')?.textContent || '';
      const forbidden = ['同步中', '雲端讀取中', '顯示快取', '寫入暫停'];
      return Boolean(modal) && sync.includes('已同步') && forbidden.every(label => !sync.includes(label));
    }, 'ISOLATED_IMPORT_SUCCESS_SYNC_TIMEOUT', 60_000);
    const completedAt = performance.now();
    const modalText = node.querySelector('[data-testid="buyanime-import-success-modal"]')?.textContent || '';
    const syncText = node.querySelector('[data-global-sync-control]')?.textContent || '';
    if (!modalText.includes('雲端資料已同步完成')) throw new Error('ISOLATED_IMPORT_MODAL_NOT_AUTHORITATIVE');
    return {
      totalMs: Math.round(completedAt - startedAt),
      modalText,
      syncText,
      commits: durations.length,
      maxDurationMs: Math.max(0, ...durations),
    };
  } finally {
    root.unmount();
    node.remove();
    uninstallBridge();
    setProviderMode('experimental');
  }
}
