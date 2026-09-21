import type { IDataProvider } from './types';
import type { PurchaseBatchTransactionCommand } from './cloud/purchaseBatchTransaction';
import type { JapanPackageTransactionCommand, JapanPackageTransactionSuccess } from './cloud/japanPackageTransaction';
import type { OutboundShipmentDeleteCommand, OutboundShipmentDeleteSuccess } from './cloud/outboundShipmentTransaction';
import type { CloudRestoreCommand, CloudRestoreResult } from './cloud/cloudAtomicRestore';
import type { CloudRestoreTargetCompatibilityResult } from './cloud/cloudRestorePortability';
import { db, calculateFinalMyacgDemand } from '../lib/db';
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

export class LocalProvider implements IDataProvider {
  async getInventory(): Promise<InventoryItem[]> {
    return db.getInventory();
  }
  async upsertInventory(items: InventoryItem[]): Promise<ImportStats> {
    return db.upsertInventory(items);
  }
  async getSalesOrders(): Promise<SalesOrder[]> {
    return db.getSalesOrders();
  }
  async saveSalesOrders(items: SalesOrder[]): Promise<void> {
    return db.saveSalesOrders(items);
  }
  async getSalesOrderItems(): Promise<SalesOrderItem[]> {
    return db.getSalesOrderItems();
  }
  async saveSalesOrderItems(items: SalesOrderItem[]): Promise<void> {
    return db.saveSalesOrderItems(items);
  }
  async getProductGroups(): Promise<ProductGroup[]> {
    return db.getProductGroups();
  }
  async saveProductGroups(groups: ProductGroup[]): Promise<void> {
    return db.saveProductGroups(groups);
  }
  async getProductCategories(): Promise<ProductCategory[]> {
    return db.getProductCategories();
  }
  async saveProductCategories(categories: ProductCategory[]): Promise<void> {
    return db.saveProductCategories(categories);
  }
  async getProductVariants(options?: { recalc?: boolean; raw?: boolean }): Promise<ProductVariant[]> {
    return db.getProductVariants(options);
  }
  async saveProductVariants(variants: ProductVariant[]): Promise<void> {
    const allLocalVars = await db.getProductVariants();
    const allLocalVarsMap = new Map(allLocalVars.map(v => [v.id, v]));
    for (const v of variants) {
      const existing = allLocalVarsMap.get(v.id);
      if (existing) {
        allLocalVarsMap.set(v.id, { ...existing, ...v });
      } else {
        allLocalVarsMap.set(v.id, v);
      }
    }
    const mergedVars = Array.from(allLocalVarsMap.values());
    return db.saveProductVariants(mergedVars);
  }
  async deleteProductVariant(id: string): Promise<void> {
    return db.deleteProductVariant(id);
  }
  async updateProductVariantPatch(id: string, patch: Partial<ProductVariant>): Promise<void> {
    return db.updateProductVariantPatch(id, patch);
  }
  async updateProductVariantPatchBulk(patches: { id: string, patch: Partial<ProductVariant> }[]): Promise<void> {
    return db.updateProductVariantPatchBulk(patches);
  }
  async getPurchaseBatches(): Promise<PurchaseBatch[]> {
    return db.getPurchaseBatches();
  }
  async savePurchaseBatches(batches: PurchaseBatch[]): Promise<void> {
    return db.savePurchaseBatches(batches);
  }
  async getPurchaseBatchItems(): Promise<PurchaseBatchItem[]> {
    return db.getPurchaseBatchItems();
  }
  async savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void> {
    return db.savePurchaseBatchItems(items);
  }
  async savePurchaseBatchTransaction(command: PurchaseBatchTransactionCommand): Promise<void> {
    const [batches, items] = await Promise.all([this.getPurchaseBatches(), this.getPurchaseBatchItems()]);
    const nextBatches = [...batches.filter(batch => batch.id !== command.batch.id), command.batch];
    const nextItems = [...items.filter(item => item.purchase_batch_id !== command.batch.id), ...command.items];
    return db.savePurchaseBatchTransaction(nextBatches, nextItems);
  }
  async getPrivateOrders(): Promise<PrivateOrder[]> {
    return db.getPrivateOrders();
  }
  async savePrivateOrders(orders: PrivateOrder[]): Promise<void> {
    return db.savePrivateOrders(orders);
  }
  async getPrivateOrderItems(): Promise<PrivateOrderItem[]> {
    return db.getPrivateOrderItems();
  }
  async savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void> {
    return db.savePrivateOrderItems(items);
  }
  async deletePrivateOrderItems(ids: string[]): Promise<void> {
    return db.deletePrivateOrderItems(ids);
  }
  async getJapanPackages(): Promise<JapanPackage[]> {
    return db.getJapanPackages();
  }
  async saveJapanPackages(packages: JapanPackage[]): Promise<void> {
    return db.saveJapanPackages(packages);
  }
  async getJapanPackageItems(): Promise<JapanPackageItem[]> {
    return db.getJapanPackageItems();
  }
  async saveJapanPackageItems(items: JapanPackageItem[]): Promise<void> {
    return db.saveJapanPackageItems(items);
  }
  async applyJapanPackageTransaction(command: JapanPackageTransactionCommand): Promise<JapanPackageTransactionSuccess> {
    const [packages, items] = await Promise.all([this.getJapanPackages(), this.getJapanPackageItems()]);
    let nextPackages: JapanPackage[];
    let nextItems = [...items];
    if (command.transactionType === 'create-package') {
      nextPackages = [...packages.filter(pkg => pkg.id !== command.package.id), command.package];
    } else if (command.transactionType === 'attach-items') {
      nextItems = [...items, ...command.items];
      nextPackages = packages.map(pkg => pkg.id === command.packageId && pkg.status === 'confirmed'
        ? { ...pkg, status: 'arrived', updated_at: new Date().toISOString() }
        : pkg);
    } else {
      const updates = new Map(command.updates.map(update => [update.itemId, update]));
      nextItems = items.map(item => {
        const update = updates.get(item.id);
        return update ? {
          ...item,
          checked: update.checked,
          checked_at: update.checked ? (update.checkedAt ?? new Date().toISOString()) : undefined,
          updated_at: new Date().toISOString(),
        } : item;
      });
      const packageItems = nextItems.filter(item => item.japan_package_id === command.packageId);
      const allChecked = packageItems.length > 0 && packageItems.every(item => item.checked);
      nextPackages = packages.map(pkg => {
        if (pkg.id !== command.packageId || pkg.status === 'problem') return pkg;
        const status = allChecked ? 'confirmed' : pkg.status === 'confirmed' ? 'arrived' : pkg.status;
        return status === pkg.status ? pkg : {
          ...pkg,
          status,
          arrived_at: pkg.arrived_at || (status === 'arrived' || status === 'confirmed' ? new Date().toISOString().slice(0, 10) : undefined),
          updated_at: new Date().toISOString(),
        };
      });
    }
    await db.saveJapanPackageTransaction(nextPackages, nextItems);
    const canonicalPackage = nextPackages.find(pkg => pkg.id === (command.transactionType === 'create-package' ? command.package.id : command.packageId));
    if (!canonicalPackage) throw new Error('JAPAN_PACKAGE_LOCAL_RESULT_MISSING');
    return {
      ok: true,
      transactionType: command.transactionType,
      idempotencyKey: command.idempotencyKey,
      replayed: false,
      package: canonicalPackage as unknown as Record<string, unknown>,
      items: nextItems.filter(item => item.japan_package_id === canonicalPackage.id) as unknown as Array<Record<string, unknown>>,
    };
  }
  async getOutboundShipments(): Promise<OutboundShipment[]> {
    return db.getOutboundShipments();
  }
  async saveOutboundShipments(shipments: OutboundShipment[]): Promise<void> {
    return db.saveOutboundShipments(shipments);
  }
  async getOutboundShipmentItems(): Promise<OutboundShipmentItem[]> {
    return db.getOutboundShipmentItems();
  }
  async saveOutboundShipmentItems(items: OutboundShipmentItem[]): Promise<void> {
    return db.saveOutboundShipmentItems(items);
  }
  async deleteOutboundShipmentTransaction(command: OutboundShipmentDeleteCommand): Promise<OutboundShipmentDeleteSuccess> {
    const [shipments, items] = await Promise.all([db.getOutboundShipments(), db.getOutboundShipmentItems()]);
    const shipment = shipments.find(entry => entry.id === command.shipmentId);
    if (!shipment) throw new Error('OUTBOUND_LOCAL_SHIPMENT_MISSING');
    const itemIds = items.filter(item => item.outbound_shipment_id === command.shipmentId).map(item => item.id).sort();
    await db.saveOutboundShipmentTransaction(
      shipments.filter(entry => entry.id !== command.shipmentId),
      items.filter(item => item.outbound_shipment_id !== command.shipmentId),
    );
    return {
      ok: true,
      transactionType: 'delete-shipment',
      idempotencyKey: command.idempotencyKey,
      replayed: false,
      shipmentId: command.shipmentId,
      itemIds,
    };
  }
  async getBundleComponents(): Promise<BundleComponent[]> {
    return db.getBundleComponents();
  }
  async saveBundleComponents(components: BundleComponent[]): Promise<void> {
    return db.saveBundleComponents(components);
  }
  async saveBundleComponentsForVariant(bundleVariantId: string, componentVariantIds: string[]): Promise<void> {
    const all = await this.getBundleComponents();
    const filtered = all.filter(c => c.bundle_variant_id !== bundleVariantId);
    const now = new Date().toISOString();
    const newItems: BundleComponent[] = componentVariantIds.map(cId => ({
      id: crypto.randomUUID(),
      bundle_variant_id: bundleVariantId,
      component_variant_id: cId,
      created_at: now
    }));
    await this.saveBundleComponents([...filtered, ...newItems]);
  }
  async getImportBatches(): Promise<ImportBatch[]> {
    return db.getImportBatches();
  }
  async saveImportBatches(batches: ImportBatch[]): Promise<void> {
    return db.saveImportBatches(batches);
  }
  async exportData(): Promise<void> {
    return db.exportData();
  }
  async importData(jsonString: string): Promise<boolean> {
    return db.importData(jsonString);
  }
  async clearData(): Promise<void> {
    return db.clearData();
  }
  async clearPurchaseRecords(): Promise<void> {
    return db.clearPurchaseRecords();
  }
  async createPurchaseRecordFromInventory(itemCodes: string[]): Promise<void> {
    await db.createPurchaseRecordFromInventory(itemCodes);
    const inventory = await db.getInventory();
    const salesOrderItems = await db.getSalesOrderItems();
    const allVariants = await db.getProductVariants();
    
    const targetCodes = new Set(itemCodes.map(code => code.trim().toUpperCase()));
    let changed = false;
    
    for (const v of allVariants) {
      if (v.myacg_item_code && targetCodes.has(v.myacg_item_code.trim().toUpperCase())) {
        const effectiveMyacg = calculateFinalMyacgDemand(v.myacg_item_code, inventory, salesOrderItems);
        if (v.myacg_auto_quantity !== effectiveMyacg || v.effective_myacg_quantity !== effectiveMyacg) {
          v.myacg_auto_quantity = effectiveMyacg;
          v.effective_myacg_quantity = effectiveMyacg;
          changed = true;
        }
      }
    }
    
    if (changed) {
      await db.saveProductVariants(allVariants);
    }
  }
  async reparseProductVariants(): Promise<void> {
    return db.reparseProductVariants();
  }
  async reparseProductTitles(): Promise<void> {
    return db.reparseProductTitles();
  }
  async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number, upgradedSkusCount?: number }> {
    return db.syncProductGroupsWithInventory();
  }
  async deleteProductGroup(groupId: string): Promise<void> {
    const groups = await db.getProductGroups();
    const updatedGroups = groups.filter(g => g.id !== groupId);
    await db.saveProductGroups(updatedGroups);

    const categories = await db.getProductCategories();
    const updatedCategories = categories.filter(c => c.product_group_id !== groupId);
    await db.saveProductCategories(updatedCategories);

    const variants = await db.getProductVariants();
    const updatedVariants = variants.filter(v => v.product_group_id !== groupId);
    await db.saveProductVariants(updatedVariants);
  }
  async deleteProductGroups(groupIds: string[]): Promise<void> {
    const groups = await db.getProductGroups();
    const updatedGroups = groups.filter(g => !groupIds.includes(g.id));
    await db.saveProductGroups(updatedGroups);

    const categories = await db.getProductCategories();
    const updatedCategories = categories.filter(c => !c.product_group_id || !groupIds.includes(c.product_group_id));
    await db.saveProductCategories(updatedCategories);

    const variants = await db.getProductVariants();
    const updatedVariants = variants.filter(v => !v.product_group_id || !groupIds.includes(v.product_group_id));
    await db.saveProductVariants(updatedVariants);
  }
  async canWriteCloud(): Promise<boolean> {
    return true;
  }
  async getLastImportBackup(): Promise<{ data: string; timestamp: string } | null> {
    return db.getLastImportBackup();
  }
  async saveLastImportBackup(backup: { data: string; timestamp: string }): Promise<void> {
    return db.saveLastImportBackup(backup);
  }
  async restoreBackup(backupData: any): Promise<boolean> {
    return db.importData(JSON.stringify(backupData));
  }
  async validateCloudRestoreTarget(_command: CloudRestoreCommand): Promise<CloudRestoreTargetCompatibilityResult> {
    void _command;
    throw new Error('CLOUD_RESTORE_REQUIRES_CLOUD_MODE');
  }
  async restoreCloudSnapshot(_command: CloudRestoreCommand): Promise<CloudRestoreResult> {
    void _command;
    throw new Error('CLOUD_RESTORE_REQUIRES_CLOUD_MODE');
  }
}

