// Isolated fake Supabase (REST + Auth + Realtime websocket) for the Realtime full-read budget regression. No network.
// Serves rows of an ERP2 cloud-authoritative backup (path via environment); counts every request and response bytes.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const RESOURCE_TABLE = {
  inventory: 'inventory_items', productGroups: 'product_groups', productCategories: 'product_categories',
  dashboardCategoryImages: 'dashboard_category_images', productVariants: 'product_variants', bundleComponents: 'bundle_components',
  purchaseBatches: 'purchase_batches', purchaseBatchItems: 'purchase_batch_items', privateOrders: 'private_orders',
  privateOrderItems: 'private_order_items', salesOrders: 'sales_orders', salesOrderItems: 'sales_order_items',
  importBatches: 'import_batches', japanPackages: 'japan_packages', japanPackageItems: 'japan_package_items',
  outboundShipments: 'outbound_shipments', outboundShipmentItems: 'outbound_shipment_items', wacaOrders: 'waca_orders',
  wacaItems: 'waca_order_items', wacaMappings: 'waca_mappings', myacgMasterLinks: 'waca_master_links',
  wacaImportBatches: 'waca_import_batches', wacaCutoverAudit: 'waca_cutover_audit', wacaCutoverState: 'waca_state',
};
export const USER_ID = '00000000-0000-4000-8000-0000000000aa';

export function loadTables(backupPath) {
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
  const tables = {};
  for (const [resource, table] of Object.entries(RESOURCE_TABLE)) tables[table] = backup.data[resource] ?? [];
  tables.profiles = [{ user_id: USER_ID, role: 'owner', email: 'owner@example.test' }];
  tables.erp_cloud_restore_epoch = [{ singleton: true, epoch: 3, restored_at: '2026-10-16T02:20:45Z', snapshot_fingerprint: 'x', updated_at: '2026-10-16T02:20:45Z' }];
  return tables;
}

const decode = value => decodeURIComponent(String(value).replace(/\+/gu, ' '));
function applyFilters(rows, params) {
  let out = rows;
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(key)) continue;
    const value = decode(raw);
    const dot = value.indexOf('.');
    const op = value.slice(0, dot); const arg = value.slice(dot + 1);
    if (op === 'is' && arg === 'null') out = out.filter(row => row[key] == null);
    else if (op === 'eq') out = out.filter(row => String(row[key]) === arg);
    else if (op === 'gt') out = out.filter(row => row[key] != null && String(row[key]) > arg);
    else if (op === 'gte') out = out.filter(row => row[key] != null && String(row[key]) >= arg);
    else if (op === 'in') { const set = new Set(arg.replace(/^\(|\)$/gu, '').split(',').map(s => s.replace(/^"|"$/gu, ''))); out = out.filter(row => set.has(String(row[key]))); }
    else if (op === 'not' && arg === 'is.null') out = out.filter(row => row[key] != null);
  }
  const order = params.get('order');
  if (order) {
    const [col, dir] = decode(order).split(',')[0].split('.');
    out = [...out].sort((a, b) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : String(a[col] ?? '') > String(b[col] ?? '') ? 1 : 0) * (dir === 'desc' ? -1 : 1));
  }
  return out;
}
function project(rows, select) {
  if (!select || select === '*') return rows;
  const cols = decode(select).split(',').map(c => c.trim()).filter(c => c && !c.includes('('));
  if (cols.includes('*')) return rows;
  return rows.map(row => Object.fromEntries(cols.map(c => [c, row[c] ?? null])));
}

export class FakeSupabase {
  constructor(tables) { this.tables = tables; this.reset(); this.sockets = new Set(); this.unknown = new Set(); }
  reset() { this.log = []; }
  record(entry) { this.log.push({ at: Date.now(), ...entry }); }
  summary(label) {
    const by = {}; let raw = 0; let gz = 0; let rows = 0;
    for (const e of this.log) {
      const key = `${e.kind}:${e.table ?? e.path}`;
      by[key] ??= { n: 0, raw: 0, gz: 0, rows: 0 };
      by[key].n += 1; by[key].raw += e.raw ?? 0; by[key].gz += e.gz ?? 0; by[key].rows += e.rows ?? 0;
      raw += e.raw ?? 0; gz += e.gz ?? 0; rows += e.rows ?? 0;
    }
    const rest = this.log.filter(e => e.kind === 'rest' || e.kind === 'rpc').length;
    return { label, requests: this.log.length, restRequests: rest, rows, rawMB: +(raw / 1e6).toFixed(2), gzipMB: +(gz / 1e6).toFixed(2), by };
  }
  async handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    const send = (status, body, headers = {}, entry = {}) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      this.record({ kind: entry.kind ?? 'other', path, method, status, raw: Buffer.byteLength(text), gz: gzipSync(text).length, ...entry });
      return route.fulfill({ status, body: text, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', ...headers } });
    };
    if (method === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (path.startsWith('/auth/v1/user')) return send(200, user(), {}, { kind: 'auth' });
    if (path.startsWith('/auth/v1/token')) return send(200, session(), {}, { kind: 'auth' });
    if (path.startsWith('/auth/v1/')) return send(200, {}, {}, { kind: 'auth' });
    if (path.startsWith('/rest/v1/rpc/')) {
      const fn = path.slice('/rest/v1/rpc/'.length);
      if (fn === 'erp_read_waca_snapshot') {
        const body = { revision: this.tables.waca_state[0]?.revision ?? 0, state: this.tables.waca_state[0] ?? null, orders: this.tables.waca_orders, items: this.tables.waca_order_items, mappings: this.tables.waca_mappings, masterLinks: this.tables.waca_master_links, batches: this.tables.waca_import_batches, audit: this.tables.waca_cutover_audit };
        return send(200, body, {}, { kind: 'rpc', table: fn });
      }
      this.unknown.add(`rpc:${fn}`);
      return send(200, null, {}, { kind: 'rpc', table: fn });
    }
    if (path.startsWith('/rest/v1/')) {
      const table = path.slice('/rest/v1/'.length);
      if (method !== 'GET' && method !== 'HEAD') { this.unknown.add(`write:${method}:${table}`); return send(405, { message: 'read-only harness' }, {}, { kind: 'rest-write', table }); }
      if (this.failTable === table) return send(503, { message: 'injected failure' }, {}, { kind: 'rest', table });
      const base = this.tables[table];
      if (!base) { this.unknown.add(`table:${table}`); return send(200, [], { 'content-range': '*/0' }, { kind: 'rest', table }); }
      let rows = applyFilters(base, url.searchParams);
      const total = rows.length;
      const range = request.headers()['range'];
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = url.searchParams.get('limit');
      if (range) { const [a, b] = range.split('-').map(Number); rows = rows.slice(a, b + 1); }
      else if (limit) rows = rows.slice(offset, offset + Number(limit));
      rows = project(rows, url.searchParams.get('select'));
      const accept = request.headers()['accept'] || '';
      const single = accept.includes('vnd.pgrst.object');
      const body = single ? (rows[0] ?? null) : rows;
      if (single && !rows[0]) return send(406, { code: 'PGRST116', message: 'no rows' }, {}, { kind: 'rest', table, rows: 0 });
      return send(200, method === 'HEAD' ? '' : body, { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${total}` }, { kind: 'rest', table, rows: Array.isArray(body) ? body.length : 1, caller: request.headers()['x-erp-caller'] });
    }
    return send(404, { message: 'unknown' }, {}, { kind: 'other' });
  }
  // Phoenix websocket (realtime-js vsn 1.0.0 JSON objects or 2.0.0 arrays)
  attachSocket(ws) {
    const self = this; const state = { ws, open: true, joins: 0, frames: 0, bytes: 0 };
    this.sockets.add(state);
    const reply = (msg, array) => {
      const text = array ? JSON.stringify([msg.join_ref ?? null, msg.ref ?? null, msg.topic, msg.event, msg.payload]) : JSON.stringify(msg);
      state.frames += 1; state.bytes += Buffer.byteLength(text);
      self.record({ kind: 'realtime-out', path: msg.event, raw: Buffer.byteLength(text), gz: Buffer.byteLength(text) });
      ws.send(text);
    };
    ws.onMessage(data => {
      let parsed; try { parsed = JSON.parse(String(data)); } catch { return; }
      const array = Array.isArray(parsed);
      const m = array ? { join_ref: parsed[0], ref: parsed[1], topic: parsed[2], event: parsed[3], payload: parsed[4] } : parsed;
      self.record({ kind: 'realtime-in', path: m.event, raw: Buffer.byteLength(String(data)) });
      if (m.event === 'heartbeat') return reply({ topic: 'phoenix', event: 'phx_reply', ref: m.ref, payload: { status: 'ok', response: {} } }, array);
      if (m.event === 'phx_join') {
        state.joins += 1;
        const pc = (m.payload?.config?.postgres_changes ?? []).map((c, i) => ({ id: 1000 + i, event: c.event, schema: c.schema, table: c.table, ...(c.filter ? { filter: c.filter } : {}) }));
        reply({ topic: m.topic, event: 'phx_reply', ref: m.ref, join_ref: m.join_ref ?? m.ref, payload: { status: 'ok', response: { postgres_changes: pc } } }, array);
        setTimeout(() => { if (state.open && self.systemMode !== 'none') reply({ topic: m.topic, event: 'system', ref: null, join_ref: m.join_ref ?? m.ref, payload: { status: 'ok', message: 'Subscribed to PostgreSQL', extension: 'postgres_changes', channel: m.topic.replace(/^realtime:/u, '') } }, array); }, 150);
        state.epochBindingId = (pc.find(c => c.table === 'erp_cloud_restore_epoch') || {}).id; state.topic = m.topic; state.joinRef = m.join_ref ?? m.ref; state.array = array;
        return;
      }
      if (m.event === 'phx_leave') return reply({ topic: m.topic, event: 'phx_reply', ref: m.ref, join_ref: m.join_ref, payload: { status: 'ok', response: {} } }, array);
      if (m.event === 'access_token') return;
      return;
    });
    ws.onClose(() => { state.open = false; self.sockets.delete(state); });
    return state;
  }
  sendEpochUpdate(epoch) {
    for (const st of this.sockets) {
      if (!st.topic) continue;
      const msg = { topic: st.topic, event: 'postgres_changes', ref: null, join_ref: st.joinRef, payload: { ids: [st.epochBindingId], data: { type: 'UPDATE', schema: 'public', table: 'erp_cloud_restore_epoch', commit_timestamp: new Date().toISOString(), columns: [], errors: null, record: { singleton: true, epoch, restored_at: new Date().toISOString() }, old_record: { singleton: true } } } };
      const text = st.array ? JSON.stringify([msg.join_ref, msg.ref, msg.topic, msg.event, msg.payload]) : JSON.stringify(msg);
      st.ws.send(text);
    }
  }
  dropAllSockets() { for (const s of [...this.sockets]) { try { s.ws.close({ code: 4000, reason: 'test drop' }); } catch { /* */ } } }
}

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
export const accessToken = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER_ID, role: 'authenticated', aud: 'authenticated', email: 'owner@example.test', exp: Math.floor(Date.now() / 1000) + 86400 * 30, iat: Math.floor(Date.now() / 1000) })}.sig`;
const user = () => ({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
export const session = () => ({ access_token: accessToken(), token_type: 'bearer', expires_in: 86400 * 30, expires_at: Math.floor(Date.now() / 1000) + 86400 * 30, refresh_token: 'fake-refresh', user: user() });
