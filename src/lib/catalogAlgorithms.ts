import { normalizeProductTitle, determineListingType, resolveMyacgSpecs, findMatchingVariant, findMatchingInventoryItem, getBaseSku,
  type InventoryItem, type ProductGroup, type ProductCategory, type ProductVariant } from './db';

// Shared algorithms only. Persistence is injected, never implicitly selected.
export interface CatalogAlgorithmContext {
  getInventory():Promise<InventoryItem[]>;
  getProductGroups():Promise<ProductGroup[]>;
  getProductCategories():Promise<ProductCategory[]>;
  getProductVariants(options?:{recalc?:boolean;raw?:boolean}):Promise<ProductVariant[]>;
  saveProductGroups(rows:ProductGroup[]):Promise<void>;
  saveProductCategories(rows:ProductCategory[]):Promise<void>;
  saveProductVariants(rows:ProductVariant[]):Promise<void>;
  readVariantSyncGuardSnapshot():Promise<{variants:ProductVariant[];verifiedEmpty:boolean}>;
  computeVariantDedupe(rows:ProductVariant[]):{canonical:ProductVariant[]};
  assertVariantSyncCandidateSafe(before:ProductVariant[],after:ProductVariant[],verifiedEmpty:boolean):void;
}
async function materializeProductMasterFromInventory(
  this: CatalogAlgorithmContext,
  itemCodes: string[],
  projectToPurchaseRecords: boolean,
): Promise<void> {
    const allInventory = await this.getInventory();
    const targetItems = allInventory.filter(i => itemCodes.includes(i.myacg_item_code));
    if (targetItems.length === 0) return;

    const groups = await this.getProductGroups();
    const categories = await this.getProductCategories();
    const variants = await this.getProductVariants();

    let groupsUpdated = false;
    let categoriesUpdated = false;
    let variantsUpdated = false;

    // Group targets by product_title to parse their names together
    const itemsByTitle: Record<string, typeof targetItems> = {};
    for (const item of targetItems) {
      if (!itemsByTitle[item.product_title]) itemsByTitle[item.product_title] = [];
      itemsByTitle[item.product_title].push(item);
    }

    for (const title of Object.keys(itemsByTitle)) {
      const itemsInGroup = itemsByTitle[title];
      
      // 1. Group
      const normalizedTitle = normalizeProductTitle(title);
      let group = groups.find(g => (g.normalized_title || normalizeProductTitle(g.title)) === normalizedTitle);
      if (!group) {
        group = {
          id: crypto.randomUUID(),
          title: title,
          normalized_title: normalizeProductTitle(title),
          listing_type: determineListingType(title),
          priority: 'Low',
          purchase_date: '',
          closing_date: '',
          release_month: '',
          has_official_site: false,
          product_url: '',
          show_in_purchase_list: projectToPurchaseRecords,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        groups.push(group);
        groupsUpdated = true;
      } else {
        // Just in case it's an old group without normalized_title
        if (!group.normalized_title) {
          group.normalized_title = normalizeProductTitle(title);
          group.listing_type = determineListingType(title);
          groupsUpdated = true;
        }
      }
      if (projectToPurchaseRecords && group.show_in_purchase_list !== true) {
        group.show_in_purchase_list = true;
        groupsUpdated = true;
      }

      // We should resolve specs using ALL variants in this group + new items
      const existingVars = variants.filter(v => v.product_group_id === group!.id);
      const allRawNames = [
        ...existingVars.map(v => v.raw_variant_name || ''),
        ...itemsInGroup.map(i => i.raw_variant_name)
      ].filter(Boolean);
      
      const resolvedSpecs = resolveMyacgSpecs(allRawNames);

      for (const item of itemsInGroup) {
        const spec = resolvedSpecs[item.raw_variant_name] || { category_label: null, variant_label: item.raw_variant_name };

        // 2. Category
        let categoryId: string | undefined;
        if (spec.category_label) {
          let category = categories.find(c => c.product_group_id === group!.id && c.title === spec.category_label);
          if (!category) {
            category = {
              id: crypto.randomUUID(),
              product_group_id: group.id,
              title: spec.category_label,
              sort_order: categories.filter(c => c.product_group_id === group!.id).length
            };
            categories.push(category);
            categoriesUpdated = true;
          }
          categoryId = category.id;
        }

        // 3. Variant
        let variant = findMatchingVariant(item, variants, group!.id);
        if (!variant) {
          variant = {
            id: crypto.randomUUID(),
            product_group_id: group.id,
            product_category_id: categoryId,
            myacg_item_code: item.myacg_item_code,
            product_title: item.product_title,
            variant_name: spec.variant_label,
            raw_variant_name: item.raw_variant_name,
            myacg_auto_quantity: 0,
            effective_myacg_quantity: 0,
            waca_auto_quantity: 0,
            note: '',
            sort_order: variants.filter(v => v.product_group_id === group!.id).length,
            source: projectToPurchaseRecords ? 'myacg_order_import' : 'inventory_import',
          };
          variants.push(variant);
          variantsUpdated = true;
        } else {
          if (
            variant.variant_name !== spec.variant_label ||
            variant.product_category_id !== categoryId ||
            variant.product_title !== item.product_title ||
            variant.raw_variant_name !== item.raw_variant_name
          ) {
            variant.variant_name = spec.variant_label;
            variant.raw_variant_name = item.raw_variant_name;
            variant.product_title = item.product_title;
            variant.product_category_id = categoryId;
            variantsUpdated = true;
          }
          if (projectToPurchaseRecords && variant.source !== 'manual' && variant.source !== 'myacg_order_import') {
            variant.source = 'myacg_order_import';
            variantsUpdated = true;
          }
        }
      }
      
      // Update existing variants that were already in the group
      for (const existingVar of existingVars) {
        if (projectToPurchaseRecords && existingVar.source !== 'manual'
          && existingVar.source !== 'myacg_order_import') {
          existingVar.source = 'myacg_order_import';
          variantsUpdated = true;
        }
        const invItem = findMatchingInventoryItem(existingVar, targetItems);
        const rawName = invItem ? invItem.raw_variant_name : existingVar.raw_variant_name;
        if (rawName) {
          const spec = resolvedSpecs[rawName];
          if (spec) {
            let categoryId: string | undefined = undefined;
            if (spec.category_label) {
              let category = categories.find(c => c.product_group_id === group!.id && c.title === spec.category_label);
              if (!category) {
                category = {
                  id: crypto.randomUUID(),
                  product_group_id: group!.id,
                  title: spec.category_label,
                  sort_order: categories.filter(c => c.product_group_id === group!.id).length
                };
                categories.push(category);
                categoriesUpdated = true;
              }
              categoryId = category.id;
            }

            let updated = false;
            if (existingVar.variant_name !== spec.variant_label) {
              existingVar.variant_name = spec.variant_label;
              updated = true;
            }
            if (existingVar.product_category_id !== categoryId) {
              existingVar.product_category_id = categoryId;
              updated = true;
            }
            if (invItem && existingVar.product_title !== invItem.product_title) {
              existingVar.product_title = invItem.product_title;
              updated = true;
            }
            if (invItem && existingVar.raw_variant_name !== invItem.raw_variant_name) {
              existingVar.raw_variant_name = invItem.raw_variant_name;
              updated = true;
            }
            if (updated) {
              variantsUpdated = true;
            }
          }
        }
      }

      // Update Category sort_order for this group
      for (const cat of categories.filter(c => c.product_group_id === group.id)) {
        const variantsInCat = variants.filter(v => v.product_group_id === group.id && v.product_category_id === cat.id);
        let minSort = 9999;
        for (const v of variantsInCat) {
            const invItem = findMatchingInventoryItem(v, targetItems);
            const vSort = (invItem?.import_sort_index ?? v.sort_order ?? 9999);
            if (vSort < minSort) minSort = vSort;
        }
        cat.sort_order = minSort;
      }
    }

    if (groupsUpdated) await this.saveProductGroups(groups);
    if (categoriesUpdated) await this.saveProductCategories(categories);
    if (variantsUpdated) await this.saveProductVariants(variants);
  }

/** Materialise the BuyAnime Product Master without opting it into Purchase Records. */
export async function ensureProductMasterFromInventory(
  this: CatalogAlgorithmContext, itemCodes: string[],
): Promise<void> {
  return materializeProductMasterFromInventory.call(this, itemCodes, false);
}

/** Explicit user projection from Product Master into Purchase Records. */
export async function createPurchaseRecordFromInventory(
  this: CatalogAlgorithmContext, itemCodes: string[],
): Promise<void> {
  return materializeProductMasterFromInventory.call(this, itemCodes, true);
}

export async function reparseProductVariants(this: CatalogAlgorithmContext): Promise<void> {
    const allInventory = await this.getInventory();
    const inventoryMap = new Map(allInventory.map(i => [i.myacg_item_code, i]));

    const groups = await this.getProductGroups();
    const categories = await this.getProductCategories();
    const variants = await this.getProductVariants({ recalc: true });

    let categoriesUpdated = false;
    let variantsUpdated = false;

    for (const group of groups) {
      const groupVariants = variants.filter(v => v.product_group_id === group.id);
      
      groupVariants.forEach(v => {
        const invItem = inventoryMap.get(v.myacg_item_code);
        if (invItem) {
          if (v.raw_variant_name !== invItem.raw_variant_name || v.product_title !== invItem.product_title) {
            v.raw_variant_name = invItem.raw_variant_name;
            v.product_title = invItem.product_title;
            variantsUpdated = true;
          }
        }
      });

      const allRawNames = groupVariants.map(v => v.raw_variant_name || '').filter(Boolean);
      const resolvedSpecs = resolveMyacgSpecs(allRawNames);

      for (const v of groupVariants) {
        if (!v.raw_variant_name) continue;
        const spec = resolvedSpecs[v.raw_variant_name];
        if (!spec) continue;

        let categoryId: string | undefined;
        if (spec.category_label) {
          let category = categories.find(c => c.product_group_id === group.id && c.title === spec.category_label);
          if (!category) {
            category = {
              id: crypto.randomUUID(),
              product_group_id: group.id,
              title: spec.category_label,
              sort_order: categories.filter(c => c.product_group_id === group.id).length
            };
            categories.push(category);
            categoriesUpdated = true;
          }
          categoryId = category.id;
        } else {
          categoryId = undefined; // Nullify category for single items
        }

        if (v.variant_name !== spec.variant_label || v.product_category_id !== categoryId) {
          v.variant_name = spec.variant_label;
          v.product_category_id = categoryId;
          variantsUpdated = true;
        }
      }
    }

    // Clean up empty categories (optional, but good practice)
    const activeCategoryIds = new Set(variants.map(v => v.product_category_id).filter(Boolean));
    const activeCategories = categories.filter(c => activeCategoryIds.has(c.id));
    if (activeCategories.length !== categories.length) {
      categories.splice(0, categories.length, ...activeCategories);
      categoriesUpdated = true;
    }

    if (categoriesUpdated) await this.saveProductCategories(categories);
    if (variantsUpdated) await this.saveProductVariants(variants);
  }

export async function syncProductGroupsWithInventory(this: CatalogAlgorithmContext, ): Promise<{ filledVariantsCount: number, affectedGroupsCount: number, upgradedSkusCount: number }> {
    const verifiedSource = await this.readVariantSyncGuardSnapshot();
    const allInventory = await this.getInventory();
    const groups = await this.getProductGroups();
    const { canonical: verifiedCanonicalVariants } = this.computeVariantDedupe(verifiedSource.variants);
    const baselineVariants = verifiedCanonicalVariants.map(variant => ({ ...variant }));
    const variants = verifiedCanonicalVariants.map(variant => ({ ...variant }));
    const categories = await this.getProductCategories();

    let filledVariantsCount = 0;
    let affectedGroupsCount = 0;
    let anyGroupChanged = false;
    let upgradedSkusCount = 0;

    for (const group of groups) {
      const groupNormTitle = group.normalized_title || normalizeProductTitle(group.title);
      const groupTitle = group.title;

      const matchingItems = allInventory.filter(item => {
        const itemNorm = item.normalized_product_title || normalizeProductTitle(item.product_title);
        if (groupNormTitle && itemNorm) {
            return groupNormTitle === itemNorm;
        }
        return item.product_title === groupTitle;
      });

      const existingVariants = variants.filter(v => v.product_group_id === group.id || 
         (v.product_category_id && categories.some(c => c.id === v.product_category_id && c.product_group_id === group.id)));

      let groupChanged = false;
      const ambiguousItemCodes = new Set<string>();

      // SKU Auto-Upgrade Phase for new catalog format
      for (const item of matchingItems) {
        const hasExactMatch = existingVariants.some(v => v.myacg_item_code === item.myacg_item_code);
        if (hasExactMatch) continue;

        const parentCode = item.myacg_parent_code || getBaseSku(item.myacg_item_code);
        if (!parentCode) continue;

        const cleanParent = parentCode.trim().toUpperCase();
        const cleanRaw = item.raw_variant_name?.trim();

        // 1. Find candidates matching strict raw_variant_name and parent code prefix, excluding manual source
        const candidates = existingVariants.filter(v => {
          if (v.source === 'manual') return false;
          
          const vCode = v.myacg_item_code.trim().toUpperCase();
          const prefixMatch = vCode === cleanParent || vCode.startsWith(cleanParent + '_');
          const nameMatch = v.raw_variant_name?.trim() === cleanRaw;
          return prefixMatch && nameMatch;
        });

        if (candidates.length === 1) {
          const matchVar = candidates[0];
          matchVar.myacg_item_code = item.myacg_item_code;
          groupChanged = true;
          anyGroupChanged = true;
          upgradedSkusCount++;
        } else if (candidates.length > 1) {
          ambiguousItemCodes.add(item.myacg_item_code);
        } else {
          // candidates.length === 0: check if variant_name matches (but raw_variant_name does not)
          const nameMatchCandidates = existingVariants.filter(v => {
            if (v.source === 'manual') return false;
            
            const vCode = v.myacg_item_code.trim().toUpperCase();
            const prefixMatch = vCode === cleanParent || vCode.startsWith(cleanParent + '_');
            const nameMatch = v.variant_name?.trim() === cleanRaw;
            return prefixMatch && nameMatch;
          });

          if (nameMatchCandidates.length > 0) {
            ambiguousItemCodes.add(item.myacg_item_code);
          }
        }
      }

      const missingItems = matchingItems.filter(item => {
        if (ambiguousItemCodes.has(item.myacg_item_code)) return false;
        const matchingVar = findMatchingVariant(item, existingVariants, group.id);
        return !matchingVar;
      });

      // 1. Process existing variants: check if they are missing from catalog and update sort_order
      for (const v of existingVariants) {
        if (v.source === 'manual') {
          continue;
        }
        const invItem = findMatchingInventoryItem(v, matchingItems);
        if (invItem) {
          let updated = false;
          if (v.catalog_missing !== false) {
            v.catalog_missing = false;
            updated = true;
          }
          if (v.sort_order !== (invItem.import_sort_index ?? 9999)) {
            v.sort_order = invItem.import_sort_index ?? 9999;
            updated = true;
          }
          if (v.product_title !== invItem.product_title) {
            v.product_title = invItem.product_title;
            updated = true;
          }
          if (v.raw_variant_name !== invItem.raw_variant_name) {
            v.raw_variant_name = invItem.raw_variant_name;
            updated = true;
          }
          if (updated) {
            groupChanged = true;
          }
        } else {
          if (v.catalog_missing !== true || v.sort_order !== 999999) {
            v.catalog_missing = true;
            v.sort_order = 999999;
            groupChanged = true;
          }
        }
      }

      // 2. Add missing items from catalog
      if (missingItems.length > 0) {
        affectedGroupsCount++;
        groupChanged = true;
        
        const rawNames = matchingItems.map(i => i.raw_variant_name || '');
        const resolved = resolveMyacgSpecs(rawNames);

        for (const item of missingItems) {
            const spec = resolved[item.raw_variant_name || ''];
            let catId = undefined;
            
            if (spec && spec.category_label) {
                let cat = categories.find(c => c.product_group_id === group.id && c.title === spec.category_label);
                if (!cat) {
                    cat = {
                        id: crypto.randomUUID(),
                        product_group_id: group.id,
                        title: spec.category_label,
                        sort_order: categories.filter(c => c.product_group_id === group.id).length
                    };
                    categories.push(cat);
                }
                catId = cat.id;
            }

            const newVariant = {
                id: crypto.randomUUID(),
                product_group_id: group.id,
                product_category_id: catId,
                myacg_item_code: item.myacg_item_code,
                product_title: item.product_title,
                variant_name: spec ? spec.variant_label : (item.raw_variant_name || ''),
                myacg_auto_quantity: 0,
                effective_myacg_quantity: 0,
                note: '',
                sort_order: item.import_sort_index ?? 9999,
                catalog_missing: false
            };
            variants.push(newVariant);
            existingVariants.push(newVariant); // add to existing for category calculation later
            filledVariantsCount++;
        }

        for (const item of matchingItems) {
            if (missingItems.includes(item)) continue; 
            
            const existingVar = findMatchingVariant(item, variants, group.id);
            if (existingVar) {
                let updated = false;
                if (existingVar.product_title !== item.product_title) {
                    existingVar.product_title = item.product_title;
                    updated = true;
                }
                if (existingVar.raw_variant_name !== item.raw_variant_name) {
                    existingVar.raw_variant_name = item.raw_variant_name;
                    updated = true;
                }
                
                const spec = resolved[item.raw_variant_name || ''];
                if (spec && spec.category_label) {
                    let cat = categories.find(c => c.product_group_id === group.id && c.title === spec.category_label);
                    if (!cat) {
                        cat = {
                            id: crypto.randomUUID(),
                            product_group_id: group.id,
                            title: spec.category_label,
                            sort_order: categories.filter(c => c.product_group_id === group.id).length
                        };
                        categories.push(cat);
                    }
                    if (existingVar.product_category_id !== cat.id) {
                        existingVar.product_category_id = cat.id;
                        updated = true;
                    }
                    if (existingVar.variant_name !== spec.variant_label) {
                        existingVar.variant_name = spec.variant_label;
                        updated = true;
                    }
                } else if (spec) {
                    if (existingVar.product_category_id !== undefined) {
                        existingVar.product_category_id = undefined;
                        updated = true;
                    }
                    if (existingVar.variant_name !== spec.variant_label) {
                        existingVar.variant_name = spec.variant_label;
                        updated = true;
                    }
                }
                if (updated) {
                    groupChanged = true;
                }
            }
        }
      }

      // 3. Update category sort_order
      for (const cat of categories.filter(c => c.product_group_id === group.id)) {
        const variantsInCat = existingVariants.filter(v => v.product_category_id === cat.id);
        let minSort = 999999;
        for (const v of variantsInCat) {
          if (v.sort_order < minSort) minSort = v.sort_order;
        }
        if (variantsInCat.length > 0 && variantsInCat.every(v => v.catalog_missing)) {
          minSort = 999999; // If all are missing, put category at the end
        }
        if (cat.sort_order !== minSort) {
          cat.sort_order = minSort;
          groupChanged = true;
        }
      }

      if (groupChanged) {
        anyGroupChanged = true;
      }
    }

    if (anyGroupChanged) {
      this.assertVariantSyncCandidateSafe(
        baselineVariants,
        variants,
        verifiedSource.verifiedEmpty,
      );
      await this.saveProductCategories(categories);
        await this.saveProductVariants(variants);
    }

    // Recalculate auto quantities based on new inventory sold numbers
    await this.getProductVariants({ recalc: true });

    return { filledVariantsCount, affectedGroupsCount, upgradedSkusCount };
  }
