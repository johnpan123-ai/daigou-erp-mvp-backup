import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import JapanPackagesList from '../../src/pages/JapanPackagesList';
import { ViewportProvider } from '../../src/contexts/ViewportContext';
import { dataProvider } from '../../src/providers/dataProvider';
import { CloudOfflineWriteError } from '../../src/providers/cloud/cloudConnectivity';
import type { JapanPackage } from '../../src/lib/db';
import type { JapanPackageTransactionCommand, JapanPackageTransactionSuccess } from '../../src/providers/cloud/japanPackageTransaction';

type Scenario = 'success' | 'offline' | 'pending';
const scenario = (new URLSearchParams(window.location.search).get('scenario') || 'success') as Scenario;
let packages: JapanPackage[] = [];
let transactionCalls = 0;
let rpcCalls = 0;
let releasePending: (() => void) | null = null;
const idempotencyKeys: string[] = [];

Object.assign(dataProvider, {
  getJapanPackages: async () => structuredClone(packages),
  getJapanPackageItems: async () => [],
  saveJapanPackages: async () => undefined,
  applyRelatedTransaction: async () => { throw new Error('UNEXPECTED_RELATED_TRANSACTION'); },
  applyJapanPackageTransaction: async (command: JapanPackageTransactionCommand): Promise<JapanPackageTransactionSuccess> => {
    transactionCalls += 1;
    idempotencyKeys.push(command.idempotencyKey);
    if (scenario === 'offline') throw new CloudOfflineWriteError();
    rpcCalls += 1;
    if (scenario === 'pending') await new Promise<void>(resolve => { releasePending = resolve; });
    if (command.transactionType !== 'create-package') throw new Error('EXPECTED_CREATE_PACKAGE');
    const canonical = { ...command.package, database_id: command.package.id, version: 1 };
    packages = [...packages.filter(row => row.id !== canonical.id), canonical];
    return {
      ok: true,
      transactionType: 'create-package',
      idempotencyKey: command.idempotencyKey,
      replayed: false,
      package: structuredClone(canonical) as unknown as Record<string, unknown>,
      items: [],
      syncPending: false,
    };
  },
});

window.__JAPAN_PACKAGE_CREATE_TEST__ = {
  snapshot: () => ({
    scenario,
    transactionCalls,
    rpcCalls,
    packages: structuredClone(packages),
    idempotencyKeys: [...idempotencyKeys],
  }),
  releasePending: () => releasePending?.(),
};

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={['/japan-packages']}>
      <ViewportProvider><JapanPackagesList /></ViewportProvider>
    </MemoryRouter>
  </React.StrictMode>,
);

declare global {
  interface Window {
    __JAPAN_PACKAGE_CREATE_TEST__: {
      snapshot: () => Record<string, unknown>;
      releasePending: () => void;
    };
  }
}
