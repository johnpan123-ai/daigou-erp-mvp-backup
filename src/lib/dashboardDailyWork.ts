import type { InventoryItem, ProductGroup, ProductVariant } from './db';
import { normalizeJapanPackageReceivingName } from './japanPackageReceivingDisplay';

const FIXED_STOREFRONT_PREFIX = '【小河馬日本代購】';

export const normalizeDashboardWorkTitle = (value: string): string => {
    const original = value.trim();
    if (!original.startsWith(FIXED_STOREFRONT_PREFIX)) return original;

    const afterPrefix = original.slice(FIXED_STOREFRONT_PREFIX.length).trimStart();
    const hasImmediatePreorderMarker = /^預購(?=\s|$)/u.test(afterPrefix);
    const normalized = normalizeJapanPackageReceivingName(original);
    if (!hasImmediatePreorderMarker) return normalized;

    // Some storefront titles place stable listing labels between 預購 and the
    // release month. Keep those useful labels, but remove the leading month.
    return normalized
        .replace(/^((?:(?:再版|代理版|代理)\s+)*)\d{2,4}年\d{1,2}月(?=\s|$)\s*/u, '$1')
        .trim() || original;
};

export interface UnlistedProcessedSnapshot {
    catalog_import_id?: string;
    processed_group_ids?: string[];
}

export type ProductDisplayCategory = 'c108' | 'hololive' | 'vspo' | 'proxy' | 'other';

const normalizeForCategoryMatch = (value?: string | null): string => {
    if (!value) return '';
    return value.toLowerCase().replace(/[\s!！?？\-_()（）.* ,]/g, '');
};

/** Mirrors the accepted PurchaseRecords display-category priority and proxy rules. */
export function buildProductDisplayCategoryMap(
    groups: ProductGroup[],
    variants: ProductVariant[],
    inventoryItems: InventoryItem[],
): Map<string, ProductDisplayCategory> {
    const variantsByGroup = new Map<string, ProductVariant[]>();
    variants.forEach(variant => {
        if (!variant.product_group_id) return;
        const existing = variantsByGroup.get(variant.product_group_id) ?? [];
        existing.push(variant);
        variantsByGroup.set(variant.product_group_id, existing);
    });

    const inventoryByCode = new Map<string, InventoryItem>();
    inventoryItems.forEach(item => {
        if (!inventoryByCode.has(item.myacg_item_code)) inventoryByCode.set(item.myacg_item_code, item);
    });

    const proxyKeywords = [
        '代理版', '代理', 'gsc', 'good smile', 'max factory', 'furyu', '景品', 'sega', 'bandai', 'kotobukiya',
    ];
    const matchesProxyText = (value?: string | null) => {
        if (!value) return false;
        const lower = value.toLowerCase();
        return proxyKeywords.some(keyword => lower.includes(keyword));
    };

    const categoryMap = new Map<string, ProductDisplayCategory>();
    groups.forEach(group => {
        const groupVariants = variantsByGroup.get(group.id) ?? [];
        const isC108 = normalizeForCategoryMatch(group.title?.normalize('NFKC')).includes('c108')
            || normalizeForCategoryMatch(group.normalized_title?.normalize('NFKC')).includes('c108');

        const isProxy = group.listing_type === '代理版'
            || group.source_type === '代理版'
            || groupVariants.some(variant => inventoryByCode.get(variant.myacg_item_code)?.listing_type === '代理版')
            || matchesProxyText(group.title)
            || matchesProxyText(group.normalized_title)
            || groupVariants.some(variant => (
                matchesProxyText(variant.variant_name)
                || matchesProxyText(variant.raw_variant_name)
                || matchesProxyText(variant.product_title)
            ))
            || groupVariants.some(variant => {
                const item = inventoryByCode.get(variant.myacg_item_code);
                return matchesProxyText(item?.product_title) || matchesProxyText(item?.raw_variant_name);
            });

        if (isC108) {
            categoryMap.set(group.id, 'c108');
            return;
        }
        if (isProxy) {
            categoryMap.set(group.id, 'proxy');
            return;
        }

        const title = normalizeForCategoryMatch(group.title);
        const normalizedTitle = normalizeForCategoryMatch(group.normalized_title);
        if (title.includes('hololive') || normalizedTitle.includes('hololive')) {
            categoryMap.set(group.id, 'hololive');
        } else if (
            title.includes('vspo')
            || title.includes('ぶいすぽ')
            || normalizedTitle.includes('vspo')
            || normalizedTitle.includes('ぶいすぽ')
        ) {
            categoryMap.set(group.id, 'vspo');
        } else {
            categoryMap.set(group.id, 'other');
        }
    });

    return categoryMap;
}

interface PendingUnlistedGroupsInput {
    groups: ProductGroup[];
    variants: ProductVariant[];
    inventoryItems: InventoryItem[];
    today: string;
    processedSnapshot?: UnlistedProcessedSnapshot | null;
}

const normalizeClosingDate = (value?: string | null): string => {
    if (!value) return '';
    const match = value.trim().replace(/\//g, '-').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!match) return '';
    return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
};

/**
 * Mirrors the accepted unlisted-items queue rules without mutating its state.
 * The dashboard only consumes the resulting count/link; it never marks work done.
 */
export function getPendingUnlistedGroupIds({
    groups,
    variants,
    inventoryItems,
    today,
    processedSnapshot,
}: PendingUnlistedGroupsInput): string[] {
    let latestImportId: string | undefined;
    let latestImportTime = '';

    inventoryItems.forEach(item => {
        if (item.catalog_last_seen_at && item.catalog_last_seen_at > latestImportTime) {
            latestImportTime = item.catalog_last_seen_at;
            latestImportId = item.latest_catalog_import_id;
        }
    });

    const latestInventory = latestImportId
        ? inventoryItems.filter(item => item.latest_catalog_import_id === latestImportId)
        : inventoryItems;
    const catalogSkus = new Set(
        latestInventory
            .map(item => item.myacg_item_code?.trim().toUpperCase())
            .filter((sku): sku is string => Boolean(sku)),
    );

    const currentImportKey = latestImportId ?? '';
    const processedIds = processedSnapshot && processedSnapshot.catalog_import_id === currentImportKey
        ? new Set(processedSnapshot.processed_group_ids ?? [])
        : new Set<string>();

    const variantsByGroup = new Map<string, ProductVariant[]>();
    variants.forEach(variant => {
        if (!variant.product_group_id) return;
        const existing = variantsByGroup.get(variant.product_group_id) ?? [];
        existing.push(variant);
        variantsByGroup.set(variant.product_group_id, existing);
    });

    return groups
        .filter(group => {
            const closingDate = normalizeClosingDate(group.closing_date);
            if (!closingDate || closingDate >= today || processedIds.has(group.id)) return false;

            return (variantsByGroup.get(group.id) ?? []).some(variant => {
                const sku = variant.myacg_item_code?.trim().toUpperCase();
                return Boolean(sku && catalogSkus.has(sku));
            });
        })
        .map(group => group.id);
}
