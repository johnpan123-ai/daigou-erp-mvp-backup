import type { BundleComponent, JapanPackageItem, OutboundShipment, OutboundShipmentItem, ProductGroup, ProductVariant } from '../lib/db';

/** Return-cache identity shared by the outbound list and the detail page (which patches it). */
export const OUTBOUND_LIST_CACHE_KEY = 'outbound-shipments-list';
export type OutboundListRead = [OutboundShipment[], OutboundShipmentItem[], JapanPackageItem[], ProductGroup[], ProductVariant[], BundleComponent[]];
