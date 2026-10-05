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
import type { PurchaseBatchTransactionCommand } from './cloud/purchaseBatchTransaction';
import type { PrivateOrderTransactionCommand } from './cloud/privateOrderTransaction';
import type { RelatedTransactionCommand } from './cloud/relatedTransaction';
import type { JapanPackageTransactionCommand, JapanPackageTransactionSuccess } from './cloud/japanPackageTransaction';
import type { OutboundShipmentDeleteCommand, OutboundShipmentDeleteSuccess } from './cloud/outboundShipmentTransaction';
import type {
  CloudRestoreAttemptCommand,
  CloudRestoreAttemptOutcome,
  CloudRestoreCommand,
  CloudRestoreExecutionCommand,
  CloudRestoreResult,
} from './cloud/cloudAtomicRestore';
import type { CloudRestoreTargetCompatibilityResult } from './cloud/cloudRestorePortability';

export interface IDataProvider {
  getInventory(): Promise<InventoryItem[]>;
  upsertInventory(items: InventoryItem[]): Promise<ImportStats>;
  
  getSalesOrders(): Promise<SalesOrder[]>;
  saveSalesOrders(items: SalesOrder[]): Promise<void>;
  getSalesOrderItems(): Promise<SalesOrderItem[]>;
  saveSalesOrderItems(items: SalesOrderItem[]): Promise<void>;

  getProductGroups(): Promise<ProductGroup[]>;
  saveProductGroups(groups: ProductGroup[]): Promise<void>;
  getProductCategories(): Promise<ProductCategory[]>;
  saveProductCategories(categories: ProductCategory[]): Promise<void>;
  getProductVariants(options?: { recalc?: boolean; raw?: boolean }): Promise<ProductVariant[]>;
  saveProductVariants(variants: ProductVariant[]): Promise<void>;
  deleteProductVariant(id: string): Promise<void>;
  updateProductVariantPatch(id: string, patch: Partial<ProductVariant>): Promise<void>;
  updateProductVariantPatchBulk(patches: { id: string, patch: Partial<ProductVariant> }[]): Promise<void>;

  getPurchaseBatches(): Promise<PurchaseBatch[]>;
  savePurchaseBatches(batches: PurchaseBatch[]): Promise<void>;
  getPurchaseBatchItems(): Promise<PurchaseBatchItem[]>;
  savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void>;
  savePurchaseBatchTransaction(command: PurchaseBatchTransactionCommand): Promise<void>;

  getPrivateOrders(): Promise<PrivateOrder[]>;
  savePrivateOrderTransaction(command: PrivateOrderTransactionCommand): Promise<void>;
  reconcilePrivateOrderTransaction(command: PrivateOrderTransactionCommand): Promise<boolean>;
  applyRelatedTransaction(command: RelatedTransactionCommand): Promise<void>;
  savePrivateOrders(orders: PrivateOrder[]): Promise<void>;
  getPrivateOrderItems(): Promise<PrivateOrderItem[]>;
  savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void>;
  deletePrivateOrderItems(ids: string[]): Promise<void>;

  getJapanPackages(): Promise<JapanPackage[]>;
  saveJapanPackages(packages: JapanPackage[]): Promise<void>;
  getJapanPackageItems(): Promise<JapanPackageItem[]>;
  saveJapanPackageItems(items: JapanPackageItem[]): Promise<void>;
  applyJapanPackageTransaction(command: JapanPackageTransactionCommand): Promise<JapanPackageTransactionSuccess>;

  getOutboundShipments(): Promise<OutboundShipment[]>;
  saveOutboundShipments(shipments: OutboundShipment[]): Promise<void>;
  getOutboundShipmentItems(): Promise<OutboundShipmentItem[]>;
  saveOutboundShipmentItems(items: OutboundShipmentItem[]): Promise<void>;
  deleteOutboundShipmentTransaction(command: OutboundShipmentDeleteCommand): Promise<OutboundShipmentDeleteSuccess>;

  getBundleComponents(): Promise<BundleComponent[]>;
  saveBundleComponents(components: BundleComponent[]): Promise<void>;
  saveBundleComponentsForVariant(bundleVariantId: string, componentVariantIds: string[]): Promise<void>;

  getImportBatches(): Promise<ImportBatch[]>;
  saveImportBatches(batches: ImportBatch[]): Promise<void>;

  exportData(): Promise<void>;
  importData(jsonString: string): Promise<boolean>;
  clearData(): Promise<void>;
  clearPurchaseRecords(): Promise<void>;
  ensureProductMasterFromInventory(itemCodes: string[]): Promise<void>;
  createPurchaseRecordFromInventory(itemCodes: string[]): Promise<void>;
  reparseProductVariants(): Promise<void>;
  reparseProductTitles(): Promise<void>;
  syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number, upgradedSkusCount?: number }>;
  deleteProductGroup(groupId: string): Promise<void>;
  deleteProductGroups(groupIds: string[]): Promise<void>;
  canWriteCloud(): Promise<boolean>;
  getLastImportBackup(): Promise<{ data: string; timestamp: string } | null>;
  saveLastImportBackup(backup: { data: string; timestamp: string }): Promise<void>;
  restoreBackup(backupData: any): Promise<boolean>;
  validateCloudRestoreTarget(command: CloudRestoreCommand): Promise<CloudRestoreTargetCompatibilityResult>;
  prepareCloudRestoreAttempt(command: CloudRestoreCommand): Promise<CloudRestoreAttemptOutcome>;
  reconcileCloudRestoreAttempt(command: CloudRestoreAttemptCommand): Promise<CloudRestoreAttemptOutcome>;
  restoreCloudSnapshot(command: CloudRestoreExecutionCommand): Promise<CloudRestoreResult>;
}
