const fs = require('fs');

let code = fs.readFileSync('src/lib/db.ts', 'utf8');

const syncStart = code.indexOf('async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number }> {');
const reparseStart = code.indexOf('  async reparseProductTitles(): Promise<void> {');

if (syncStart === -1 || reparseStart === -1) {
  console.log("Could not find boundaries");
  process.exit(1);
}

const newSyncFunc = `async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number }> {
    const allInventory = await this.getInventory();
    const groups = await this.getProductGroups();
    const variants = await this.getProductVariants();
    let categories = await this.getProductCategories();

    let filledVariantsCount = 0;
    let affectedGroupsCount = 0;
    let anyGroupChanged = false;

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
      const existingCodes = new Set(existingVariants.map(v => v.myacg_item_code));

      const missingItems = matchingItems.filter(item => !existingCodes.has(item.myacg_item_code));
      
      let groupChanged = false;

      // 1. Process existing variants: check if they are missing from catalog and update sort_order
      for (const v of existingVariants) {
        const invItem = matchingItems.find(i => i.myacg_item_code === v.myacg_item_code);
        if (invItem) {
          if (v.catalog_missing !== false || v.sort_order !== (invItem.import_sort_index ?? 9999)) {
            v.catalog_missing = false;
            v.sort_order = invItem.import_sort_index ?? 9999;
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
            
            const existingVar = variants.find(v => v.myacg_item_code === item.myacg_item_code);
            if (existingVar) {
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
                    existingVar.product_category_id = cat.id;
                    existingVar.variant_name = spec.variant_label;
                } else if (spec) {
                    existingVar.product_category_id = undefined;
                    existingVar.variant_name = spec.variant_label;
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
        await this.saveProductCategories(categories);
        await this.saveProductVariants(variants);
    }

    return { filledVariantsCount, affectedGroupsCount };
  }

`;

code = code.substring(0, syncStart) + newSyncFunc + code.substring(reparseStart);

fs.writeFileSync('src/lib/db.ts', code, 'utf8');
console.log('db.ts updated');
