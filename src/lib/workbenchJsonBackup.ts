import type { IDataProvider } from '../providers/types';
import { getProviderMode } from '../providers/providerMode';
import type { NextWacaSnapshot } from '../waca/nextStorage';

type BackupProvider = Pick<IDataProvider,
  | 'getInventory'
  | 'getSalesOrders'
  | 'getSalesOrderItems'
  | 'getProductGroups'
  | 'getProductCategories'
  | 'getProductVariants'
  | 'getPurchaseBatches'
  | 'getPurchaseBatchItems'
  | 'getPrivateOrders'
  | 'getPrivateOrderItems'
  | 'getImportBatches'
  | 'getBundleComponents'
  | 'getJapanPackages'
  | 'getJapanPackageItems'
  | 'getOutboundShipments'
  | 'getOutboundShipmentItems'
> & { getNextWacaSnapshot?: () => Promise<NextWacaSnapshot> };

export interface WorkbenchBackupResult {
  data: Record<string, unknown[]>;
  json: string;
  filename: string;
  byteLength: number;
}

const pad = (value: number) => String(value).padStart(2, '0');

export function formatBackupDateTime(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function collectWorkbenchBackupData(provider: BackupProvider): Promise<Record<string, unknown[]>> {
  const [
    inventory,
    salesOrders,
    salesOrderItems,
    productGroups,
    productCategories,
    productVariants,
    purchaseBatches,
    purchaseBatchItems,
    privateOrders,
    privateOrderItems,
    importBatches,
    bundleComponents,
    japanPackages,
    japanPackageItems,
    outboundShipments,
    outboundShipmentItems,
  ] = await Promise.all([
    provider.getInventory(),
    provider.getSalesOrders(),
    provider.getSalesOrderItems(),
    provider.getProductGroups(),
    provider.getProductCategories(),
    provider.getProductVariants(getProviderMode() === 'next' ? { raw: true } : undefined),
    provider.getPurchaseBatches(),
    provider.getPurchaseBatchItems(),
    provider.getPrivateOrders(),
    provider.getPrivateOrderItems(),
    provider.getImportBatches(),
    provider.getBundleComponents(),
    provider.getJapanPackages(),
    provider.getJapanPackageItems(),
    provider.getOutboundShipments(),
    provider.getOutboundShipmentItems(),
  ]);

  const data: Record<string, unknown[]> = {
    inventory,
    salesOrders,
    salesOrderItems,
    productGroups,
    productCategories,
    productVariants,
    purchaseBatches,
    purchaseBatchItems,
    privateOrders,
    privateOrderItems,
    importBatches,
    bundleComponents,
    japanPackages,
    japanPackageItems,
    outboundShipments,
    outboundShipmentItems,
  };
  if (getProviderMode() === 'next') {
    if (!provider.getNextWacaSnapshot) throw new Error('NEXT_WACA_BACKUP_PROVIDER_MISSING');
    const waca = await provider.getNextWacaSnapshot();
    data.wacaOrders = waca.orders;
    data.wacaItems = waca.items;
    data.wacaMappings = waca.mappings;
    data.wacaImportBatches = waca.batches;
    data.myacgMasterLinks = waca.masterLinks;
  }
  return data;
}

export function serializeAndValidateWorkbenchBackup(data: Record<string, unknown[]>): { json: string; byteLength: number } {
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value)) throw new Error(`備份集合 ${key} 格式錯誤`);
  }

  const json = JSON.stringify(data, null, 2);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('備份 JSON 無法重新解析');
  }

  const byteLength = new Blob([json], { type: 'application/json' }).size;
  if (byteLength <= 2) throw new Error('備份檔案為空');
  return { json, byteLength };
}

export function downloadWorkbenchBackupJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  if (blob.size <= 2) throw new Error('備份檔案為空');

  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function createAndDownloadWorkbenchBackup(
  provider: BackupProvider,
  filenamePrefix: string,
  now = new Date(),
  download = downloadWorkbenchBackupJson,
): Promise<WorkbenchBackupResult> {
  const data = await collectWorkbenchBackupData(provider);
  const { json, byteLength } = serializeAndValidateWorkbenchBackup(data);
  const filename = `${filenamePrefix}-${formatBackupDateTime(now)}.json`;
  download(json, filename);
  return { data, json, filename, byteLength };
}
