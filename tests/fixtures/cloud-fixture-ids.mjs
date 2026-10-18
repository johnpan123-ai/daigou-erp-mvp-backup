// Stable test identifiers shared by Node suites and the browser fixture.
export function fixtureId(value) {
  if (typeof value !== 'string' || !value || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) return value;
  const words = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (const char of value) {
    for (let i = 0; i < words.length; i += 1) words[i] = Math.imul(words[i] ^ char.charCodeAt(0), 0x01000193 + i * 2) >>> 0;
  }
  const hex = words.map(word => word.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

// Only actual fixture primary/foreign keys; external identifiers stay intact.
const identifierFields = new Set([
  'id', 'database_id', 'product_group_id', 'product_category_id', 'product_variant_id',
  'purchase_batch_id', 'purchase_batch_item_id', 'private_order_id', 'order_id',
  'japan_package_id', 'japan_package_item_id', 'outbound_shipment_id',
  'bundle_variant_id', 'component_variant_id',
]);
export function fixtureRows(value) {
  if (Array.isArray(value)) return value.map(fixtureRows);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    identifierFields.has(key) && typeof item === 'string' ? fixtureId(item) : fixtureRows(item),
  ]));
}
export function fixtureRoute(path) {
  return path.replace(/(\/)([^/?#]+)/gu, (match, slash, segment) =>
    /^(?:g|v|b|bi|jp|jpi|out|outi|po|poi|so|soi)-/u.test(segment) ? slash + fixtureId(segment) : match);
}
