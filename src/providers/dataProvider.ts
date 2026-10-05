import type { IDataProvider } from './types';
import { LocalProvider } from './localProvider';
import { supabaseProvider } from './cloud/supabaseProvider';
import { testSandboxProvider } from './testSandboxProvider';
import { getProviderMode } from './providerMode';
import type {
  InventoryItem, 
  SalesOrder, 
  SalesOrderItem, 
  ProductGroup, 
  ProductCategory, 
  ProductVariant, 
  PurchaseBatch, 
  PurchaseBatchItem, 
  PrivateOrder, 
  PrivateOrderItem, 
  ImportBatch,
  ImportStats,
  JapanPackage,
  JapanPackageItem,
  BundleComponent,
  OutboundShipment,
  OutboundShipmentItem
} from '../lib/db';
import { notifyLocalVariantCollectionChanged } from '../lib/db';
import { sanitizeCloudBusinessPatch } from './cloud/cloudFieldCas';
import type { CloudResource } from './cloud/cloudSyncDomain';
import { CloudStaleWriteError } from './cloud/cloudOptimisticLock';
import { assertCloudWriteAllowed } from './cloud/cloudConnectivity';
import type { BuyAnimeImportRecord } from './cloud/buyAnimeImportResume';
import type { PurchaseBatchTransactionCommand } from './cloud/purchaseBatchTransaction';
import type { PrivateOrderTransactionCommand } from './cloud/privateOrderTransaction';
import type { RelatedTransactionCommand } from './cloud/relatedTransaction';
import type { JapanPackageTransactionCommand, JapanPackageTransactionSuccess } from './cloud/japanPackageTransaction';
import type { OutboundShipmentDeleteCommand, OutboundShipmentDeleteSuccess } from './cloud/outboundShipmentTransaction';
import type {
  CloudRestoreAttemptCommand, CloudRestoreAttemptOutcome, CloudRestoreCandidate, CloudRestoreCommand,
  CloudRestoreExecutionCommand, CloudRestoreResult,
} from './cloud/cloudAtomicRestore';
import type { CloudRestoreTargetCompatibilityResult } from './cloud/cloudRestorePortability';
import type { CloudRestoreCandidateProofResult } from './cloud/cloudRestoreCandidateProof';
import {
  readNextWacaSnapshot, commitNextWacaSnapshot,
  type NextWacaSnapshot,
} from '../waca/nextStorage';
import { classifyWorkbenchBackup } from '../waca/backupFormat';
import { readDeadlineDurableBackup, restoreDeadlineDurableBackup,
  validateDeadlineDurableBackup } from '../lib/closingDateSidecarBackup';
import {
  isCloudAtomicBackupDocument,
  prepareCloudBackupForNextRestore,
} from './cloud/cloudBackupToNext';

export class StaleDataError extends Error {
  constructor(message = '資料已在其他分頁更新，請重新載入最新資料後再編輯。') {
    super(message);
    this.name = 'StaleDataError';
  }
}

class DynamicDataProvider implements IDataProvider {
  private localProvider = new LocalProvider();
  private supabaseProvider = supabaseProvider;
  private testSandboxProvider = testSandboxProvider;

  private tabId = Math.random().toString(36).substring(2, 9);
  private lastLoadedTime = Date.now();
  private isStale = false;
  private staleCallbacks: ((isStale: boolean) => void)[] = [];
  private cloudStaleResources = new Set<CloudResource>();

  private getWriteInfoKey(): string {
    const mode = getProviderMode();
    return mode === 'cloud' || mode === 'fallback'
      ? 'erp_cloud_cache_last_write_info'
      : 'erp_local_last_write_info';
  }

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === this.getWriteInfoKey() && e.newValue) {
          try {
            const info = JSON.parse(e.newValue);
            if (info.tabId !== this.tabId) {
              if (['cloud', 'fallback'].includes(getProviderMode())) {
                // A tab marker carries no record/version evidence. Ask the existing
                // authoritative reader; only its result may establish a conflict.
                window.dispatchEvent(new Event('cloud-cross-tab-change'));
                return;
              }
              this.isStale = true;
              this.notifySubscribers(true);
            }
          } catch (err) {}
        }
      });
    }
  }

  private notifySubscribers(stale: boolean) {
    this.staleCallbacks.forEach(callback => {
      try {
        callback(stale);
      } catch (err) {
        console.error('Error in stale callback', err);
      }
    });
  }

  onStaleChange(callback: (isStale: boolean) => void): () => void {
    this.staleCallbacks.push(callback);
    return () => {
      this.staleCallbacks = this.staleCallbacks.filter(cb => cb !== callback);
    };
  }

  registerFreshLoad(): void {
    // Reading cache is not evidence that a Cloud conflict has resolved. Only
    // the authoritative coordinator may release those resource guards.
    if (['cloud', 'fallback'].includes(getProviderMode()) || this.cloudStaleResources.size > 0) return;
    this.lastLoadedTime = Date.now();
    this.cloudStaleResources.clear();
    this.isStale = false;
    this.notifySubscribers(false);
  }

  markCloudStale(resources: CloudResource[]): void {
    resources.forEach(resource => this.cloudStaleResources.add(resource));
    this.isStale = true;
    this.notifySubscribers(true);
  }

  clearCloudStale(resources: CloudResource[]): void {
    resources.forEach(resource => this.cloudStaleResources.delete(resource));
    if (this.cloudStaleResources.size === 0) {
      this.isStale = false;
      this.notifySubscribers(false);
    }
  }

  checkIsStaleLive(): boolean {
    if (typeof window === 'undefined') return false;
    if (['cloud', 'fallback'].includes(getProviderMode())) {
      return this.isStale || this.cloudStaleResources.size > 0;
    }
    const stored = localStorage.getItem(this.getWriteInfoKey());
    if (stored) {
      try {
        const info = JSON.parse(stored);
        if (info.timestamp > this.lastLoadedTime && info.tabId !== this.tabId) {
          this.isStale = true;
          this.notifySubscribers(true);
          return true;
        }
      } catch (err) {}
    }
    return this.isStale || this.cloudStaleResources.size > 0;
  }

  private guardStale() {
    if (this.checkIsStaleLive()) {
      throw new StaleDataError();
    }
  }

  private async guardedWrite<T>(write: () => Promise<T>): Promise<T> {
    this.guardStale();
    const mode = getProviderMode();
    if (mode === 'cloud' || mode === 'fallback') assertCloudWriteAllowed();
    try {
      const result = await write();
      this.registerWrite();
      return result;
    } catch (error) {
      if (error instanceof CloudStaleWriteError) {
        this.isStale = true;
        this.notifySubscribers(true);
        throw new StaleDataError(error.message);
      }
      throw error;
    }
  }

  private async committedRestoreWrite<T>(write: () => Promise<T>): Promise<T> {
    // PREPARE has already committed a durable OWNER-only envelope. A later
    // Realtime/focus/connectivity transition must not suppress EXECUTE before
    // it reaches fetch; transport uncertainty is closed by durable reconcile.
    const result = await write();
    this.registerWrite();
    return result;
  }

  private registerWrite() {
    const now = Date.now();
    this.lastLoadedTime = now;
    this.isStale = false;
    this.notifySubscribers(false);
    localStorage.setItem(this.getWriteInfoKey(), JSON.stringify({ timestamp: now, tabId: this.tabId }));
  }

  async getInventory(): Promise<InventoryItem[]> {
    return this.getActiveProvider().getInventory();
  }
  async getInventoryCatalogSnapshot(): Promise<{
    inventory: InventoryItem[];
    productGroups: ProductGroup[];
  }> {
    const mode = getProviderMode();
    if (mode === 'cloud' || mode === 'fallback') {
      return this.supabaseProvider.getInventoryCatalogSnapshot();
    }
    const [inventory, productGroups] = await Promise.all([
      this.getActiveProvider().getInventory(),
      this.getActiveProvider().getProductGroups(),
    ]);
    return { inventory, productGroups };
  }
  async waitForCloudBootstrapConvergence(): Promise<boolean> {
    const mode = getProviderMode();
    if (mode !== 'cloud' && mode !== 'fallback') return false;
    return this.supabaseProvider.waitForCloudBootstrapConvergence();
  }
  async upsertInventory(items: InventoryItem[]): Promise<ImportStats> {
    return this.guardedWrite(() => this.getActiveProvider().upsertInventory(items));
  }
  async getBuyAnimeImportRecovery(): Promise<BuyAnimeImportRecord | null> {
    if (!['cloud','fallback'].includes(getProviderMode())) return null;
    return this.supabaseProvider.getBuyAnimeImportRecovery();
  }
  async verifyBuyAnimeImportRecovery(record: BuyAnimeImportRecord): Promise<void> {
    if (!['cloud','fallback'].includes(getProviderMode())) throw new Error('BUYANIME_RESUME_CLOUD_ONLY');
    return this.supabaseProvider.verifyBuyAnimeImportRecovery(record);
  }
  async importBuyAnimeInventory(items: InventoryItem[], fileName: string): Promise<BuyAnimeImportRecord> {
    if (!['cloud','fallback'].includes(getProviderMode())) throw new Error('BUYANIME_RESUME_CLOUD_ONLY');
    return this.guardedWrite(() => this.supabaseProvider.importBuyAnimeInventory(items, fileName));
  }
  async resumeBuyAnimeImport(record: BuyAnimeImportRecord): Promise<BuyAnimeImportRecord> {
    if (!['cloud','fallback'].includes(getProviderMode())) throw new Error('BUYANIME_RESUME_CLOUD_ONLY');
    return this.guardedWrite(() => this.supabaseProvider.resumeBuyAnimeImport(record));
  }
  async recoverPendingBuyAnimeImport(options: import('./cloud/buyAnimeImportCoordinator').BuyAnimeFlowOptions = {}): Promise<BuyAnimeImportRecord | null> {
    if (!['cloud','fallback'].includes(getProviderMode())) return null;
    // Reconcile reads first; every actual downstream write keeps provider
    // permission/freshness checks and journal CAS. Never guard-read with stale UI.
    const result = await this.supabaseProvider.recoverPendingBuyAnimeImport(options);
    if (result) this.registerWrite();
    return result;
  }
  async completeBuyAnimeImport(items: InventoryItem[], fileName: string, options: import('./cloud/buyAnimeImportCoordinator').BuyAnimeFlowOptions = {}): Promise<BuyAnimeImportRecord> {
    if (!['cloud','fallback'].includes(getProviderMode())) throw new Error('BUYANIME_RESUME_CLOUD_ONLY');
    this.guardStale();
    const result = await this.supabaseProvider.completeBuyAnimeImport(items, fileName, options);
    this.registerWrite();
    return result;
  }
  async getSalesOrders(): Promise<SalesOrder[]> {
    return this.getActiveProvider().getSalesOrders();
  }
  async saveSalesOrders(items: SalesOrder[]): Promise<void> {
    return this.guardedWrite(() => this.getActiveProvider().saveSalesOrders(items));
  }
  async getSalesOrderItems(): Promise<SalesOrderItem[]> {
    return this.getActiveProvider().getSalesOrderItems();
  }
  async saveSalesOrderItems(items: SalesOrderItem[]): Promise<void> {
    return this.guardedWrite(() => this.getActiveProvider().saveSalesOrderItems(items));
  }
  async getProductGroups(): Promise<ProductGroup[]> {
    return this.getActiveProvider().getProductGroups();
  }
  async saveProductGroups(groups: ProductGroup[]): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().saveProductGroups(groups));
  }
  async getProductCategories(): Promise<ProductCategory[]> {
    return this.getActiveProvider().getProductCategories();
  }
  async saveProductCategories(categories: ProductCategory[]): Promise<void> {
    return this.guardedWrite(() => this.getActiveProvider().saveProductCategories(categories));
  }
  async getProductVariants(options?: { recalc?: boolean; raw?: boolean }): Promise<ProductVariant[]> {
    return this.getActiveProvider().getProductVariants(options);
  }
  async saveProductVariants(variants: ProductVariant[]): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().saveProductVariants(variants));
  }
  async deleteProductVariant(id: string): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().deleteProductVariant(id));
  }
  async updateProductVariantPatch(id: string, patch: Partial<ProductVariant>): Promise<void> {
    const businessPatch = sanitizeCloudBusinessPatch('product_variants', patch);
    await this.guardedWrite(() => this.getActiveProvider().updateProductVariantPatch(id, businessPatch));
  }
  async updateProductVariantPatchBulk(patches: { id: string, patch: Partial<ProductVariant> }[]): Promise<void> {
    const businessPatches = patches.map(({ id, patch }) => ({ id, patch: sanitizeCloudBusinessPatch('product_variants', patch) }));
    await this.guardedWrite(() => this.getActiveProvider().updateProductVariantPatchBulk(businessPatches));
  }
  async getPurchaseBatches(): Promise<PurchaseBatch[]> {
    return this.getActiveProvider().getPurchaseBatches();
  }
  async savePurchaseBatches(batches: PurchaseBatch[]): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().savePurchaseBatches(batches));
  }
  async getPurchaseBatchItems(): Promise<PurchaseBatchItem[]> {
    return this.getActiveProvider().getPurchaseBatchItems();
  }
  async savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().savePurchaseBatchItems(items));
  }
  async savePurchaseBatchTransaction(command: PurchaseBatchTransactionCommand): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().savePurchaseBatchTransaction(command));
  }
  async getPrivateOrders(): Promise<PrivateOrder[]> {
    return this.getActiveProvider().getPrivateOrders();
  }
  async savePrivateOrders(orders: PrivateOrder[]): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().savePrivateOrders(orders));
  }
  async getPrivateOrderItems(): Promise<PrivateOrderItem[]> {
    return this.getActiveProvider().getPrivateOrderItems();
  }
  async savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().savePrivateOrderItems(items));
  }
  async deletePrivateOrderItems(ids: string[]): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().deletePrivateOrderItems(ids));
  }
  async getJapanPackages(): Promise<JapanPackage[]> {
    return this.getActiveProvider().getJapanPackages();
  }
  async saveJapanPackages(packages: JapanPackage[]): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().saveJapanPackages(packages));
  }
  async getJapanPackageItems(): Promise<JapanPackageItem[]> {
    return this.getActiveProvider().getJapanPackageItems();
  }
  async saveJapanPackageItems(items: JapanPackageItem[]): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().saveJapanPackageItems(items));
  }
  async applyJapanPackageTransaction(command: JapanPackageTransactionCommand): Promise<JapanPackageTransactionSuccess> {
    return this.guardedWrite(() => this.getActiveProvider().applyJapanPackageTransaction(command));
  }
  async getOutboundShipments(): Promise<OutboundShipment[]> {
    return this.getActiveProvider().getOutboundShipments();
  }
  async saveOutboundShipments(shipments: OutboundShipment[]): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().saveOutboundShipments(shipments));
  }
  async getOutboundShipmentItems(): Promise<OutboundShipmentItem[]> {
    return this.getActiveProvider().getOutboundShipmentItems();
  }
  async saveOutboundShipmentItems(items: OutboundShipmentItem[]): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().saveOutboundShipmentItems(items));
  }
  async deleteOutboundShipmentTransaction(command: OutboundShipmentDeleteCommand): Promise<OutboundShipmentDeleteSuccess> {
    return this.guardedWrite(() => this.getActiveProvider().deleteOutboundShipmentTransaction(command));
  }
  async getBundleComponents(): Promise<BundleComponent[]> {
    return this.getActiveProvider().getBundleComponents();
  }
  async saveBundleComponents(components: BundleComponent[]): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().saveBundleComponents(components));
  }
  async saveBundleComponentsForVariant(bundleVariantId: string, componentVariantIds: string[]): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().saveBundleComponentsForVariant(bundleVariantId, componentVariantIds));
  }
  async getImportBatches(): Promise<ImportBatch[]> {
    return this.getActiveProvider().getImportBatches();
  }
  async saveImportBatches(batches: ImportBatch[]): Promise<void> {
    return this.guardedWrite(() => this.getActiveProvider().saveImportBatches(batches));
  }
  async exportData(): Promise<void> {
    return this.getActiveProvider().exportData();
  }
  async importData(jsonString: string): Promise<boolean> {
    if (getProviderMode() !== 'next') {
      return this.guardedWrite(() => this.getActiveProvider().importData(jsonString));
    }
    let effectiveJson = jsonString;
    let parsed = JSON.parse(jsonString) as Record<string, unknown>;
    if (isCloudAtomicBackupDocument(parsed)) {
      const converted = await prepareCloudBackupForNextRestore(jsonString);
      effectiveJson = converted.workbenchJson;
      parsed = converted.workbenchData;
    }
    const kind = classifyWorkbenchBackup(parsed);
    if (kind !== 'waca-v2') {
      return this.guardedWrite(() => this.getActiveProvider().importData(effectiveJson));
    }
    // The sidecar lives in another IDB database. Validate it and stage it first,
    // then compensate if the core atomic import refuses the backup.
    const incoming = validateDeadlineDurableBackup(parsed);
    const before = await readDeadlineDurableBackup('next');
    await restoreDeadlineDurableBackup('next', incoming);
    try {
      const imported = await this.guardedWrite(() => this.getActiveProvider().importData(effectiveJson));
      if (!imported) await restoreDeadlineDurableBackup('next', before);
      return imported;
    } catch (error) {
      await restoreDeadlineDurableBackup('next', before);
      throw error;
    }
  }
  async savePrivateOrderTransaction(command: PrivateOrderTransactionCommand): Promise<void> {
    await this.guardedWrite(() => this.getActiveProvider().savePrivateOrderTransaction(command));
  }
  async reconcilePrivateOrderTransaction(command: PrivateOrderTransactionCommand):Promise<boolean> {
    return this.getActiveProvider().reconcilePrivateOrderTransaction(command); // SELECT-only; no stale/write guard is relaxed.
  }
  async applyRelatedTransaction(command:RelatedTransactionCommand):Promise<void> {
    await this.guardedWrite(()=>this.getActiveProvider().applyRelatedTransaction(command));
  }
  async clearData(): Promise<void> {
    return this.guardedWrite(() => this.getActiveProvider().clearData());
  }
  async clearPurchaseRecords(): Promise<void> {
    return this.guardedWrite(() => this.getActiveProvider().clearPurchaseRecords());
  }
  async ensureProductMasterFromInventory(itemCodes: string[]): Promise<void> {
    return this.guardedWrite(() => this.getActiveProvider().ensureProductMasterFromInventory(itemCodes));
  }
  async createPurchaseRecordFromInventory(itemCodes: string[]): Promise<void> {
    return this.guardedWrite(() => this.getActiveProvider().createPurchaseRecordFromInventory(itemCodes));
  }
  async reparseProductVariants(): Promise<void> {
    return this.guardedWrite(() => this.getActiveProvider().reparseProductVariants());
  }
  async reparseProductTitles(): Promise<void> {
    return this.guardedWrite(() => this.getActiveProvider().reparseProductTitles());
  }
  async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number, upgradedSkusCount?: number }> {
    return this.guardedWrite(() => this.getActiveProvider().syncProductGroupsWithInventory());
  }
  async deleteProductGroup(groupId: string): Promise<void> {
    return this.guardedWrite(() => this.getActiveProvider().deleteProductGroup(groupId));
  }
  async deleteProductGroups(groupIds: string[]): Promise<void> {
    return this.guardedWrite(() => this.getActiveProvider().deleteProductGroups(groupIds));
  }
  async canWriteCloud(): Promise<boolean> {
    return this.getActiveProvider().canWriteCloud();
  }
  async getLastImportBackup(): Promise<{ data: string; timestamp: string } | null> {
    return this.getActiveProvider().getLastImportBackup();
  }
  async saveLastImportBackup(backup: { data: string; timestamp: string }): Promise<void> {
    return this.guardedWrite(() => this.getActiveProvider().saveLastImportBackup(backup));
  }
  async restoreBackup(backupData: any): Promise<boolean> {
    return this.guardedWrite(() => this.getActiveProvider().restoreBackup(backupData));
  }
  async getNextWacaSnapshot(): Promise<NextWacaSnapshot> {
    const mode = getProviderMode();
    if (mode === 'next') return readNextWacaSnapshot();
    if (mode === 'cloud' || mode === 'fallback') return this.supabaseProvider.getWacaSnapshot();
    throw new Error('WACA_ENVIRONMENT_NOT_SUPPORTED');
  }
  async getAuthoritativeWacaVariants(): Promise<ProductVariant[]> {
    const mode = getProviderMode();
    if (mode === 'cloud' || mode === 'fallback') return this.supabaseProvider.getAuthoritativeWacaVariants();
    if (mode === 'next') return this.getProductVariants({ raw: true });
    throw new Error('WACA_ENVIRONMENT_NOT_SUPPORTED');
  }
  async getCloudDashboardCategoryImageRows(): Promise<Record<string, unknown>[]> {
    if (getProviderMode() !== 'cloud') throw new Error('CLOUD_RESTORE_REQUIRES_CLOUD_MODE');
    return this.supabaseProvider.getCloudDashboardCategoryImageRows();
  }
  async commitNextWacaSnapshot(
    snapshot: NextWacaSnapshot, expectedRevision: number, updateAutoQuantity: boolean,
  ): Promise<number> {
    const mode = getProviderMode();
    if (mode === 'cloud' || mode === 'fallback') {
      return this.guardedWrite(() => this.supabaseProvider.commitWacaSnapshot(snapshot, expectedRevision, updateAutoQuantity));
    }
    if (mode !== 'next') throw new Error('WACA_ENVIRONMENT_NOT_SUPPORTED');
    return this.guardedWrite(async () => {
      const revision = await commitNextWacaSnapshot(snapshot, expectedRevision, updateAutoQuantity);
      if (updateAutoQuantity) notifyLocalVariantCollectionChanged();
      return revision;
    });
  }
  async validateCloudRestoreTarget(command: CloudRestoreCommand): Promise<CloudRestoreTargetCompatibilityResult> {
    if (getProviderMode() !== 'cloud') throw new Error('CLOUD_RESTORE_REQUIRES_CLOUD_MODE');
    return this.supabaseProvider.validateCloudRestoreTarget(command);
  }
  async proveCloudRestoreCandidate(candidate: CloudRestoreCandidate): Promise<CloudRestoreCandidateProofResult> {
    if (getProviderMode() !== 'cloud') throw new Error('CLOUD_RESTORE_REQUIRES_CLOUD_MODE');
    return this.supabaseProvider.proveCloudRestoreCandidate(candidate);
  }
  async prepareCloudRestoreAttempt(command: CloudRestoreCommand): Promise<CloudRestoreAttemptOutcome> {
    if (getProviderMode() !== 'cloud') throw new Error('CLOUD_RESTORE_REQUIRES_CLOUD_MODE');
    return this.guardedWrite(() => this.supabaseProvider.prepareCloudRestoreAttempt(command));
  }
  async reconcileCloudRestoreAttempt(command: CloudRestoreAttemptCommand): Promise<CloudRestoreAttemptOutcome> {
    if (getProviderMode() !== 'cloud') throw new Error('CLOUD_RESTORE_REQUIRES_CLOUD_MODE');
    return this.supabaseProvider.reconcileCloudRestoreAttempt(command);
  }
  async readCloudRestoreIntegrityAudit() {
    if (getProviderMode() !== 'cloud') throw new Error('CLOUD_RESTORE_REQUIRES_CLOUD_MODE');
    return this.supabaseProvider.readCloudRestoreIntegrityAudit();
  }
  async getPendingCloudRestoreAttempts() {
    if (getProviderMode() !== 'cloud') throw new Error('CLOUD_RESTORE_REQUIRES_CLOUD_MODE');
    return this.supabaseProvider.getPendingCloudRestoreAttempts();
  }
  async restoreCloudSnapshot(command: CloudRestoreExecutionCommand): Promise<CloudRestoreResult> {
    if (getProviderMode() !== 'cloud') throw new Error('CLOUD_RESTORE_REQUIRES_CLOUD_MODE');
    return this.committedRestoreWrite(() => this.supabaseProvider.restoreCloudSnapshot(command));
  }

  private getActiveProvider(): IDataProvider {
    const mode = getProviderMode();
    if (mode === 'test' || mode === 'next' || mode === 'experimental') {
      return this.testSandboxProvider;
    }
    if (mode === 'cloud') {
      return this.supabaseProvider;
    } else if (mode === 'fallback') {
      return this.supabaseProvider;
    }
    return this.localProvider;
  }
}

export const dataProvider = new DynamicDataProvider();
if (typeof window !== 'undefined') {
  (window as any).dataProvider = dataProvider;
  (window as any).StaleDataError = StaleDataError;
}
export type { IDataProvider };
export * from './types';
