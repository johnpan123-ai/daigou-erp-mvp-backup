import type { PrivateOrder, PrivateOrderItem } from '../../lib/db';
import { buildCloudCollectionMutationPlan } from './cloudFieldCas';
import { toCloudFieldRow } from './cloudEntityPayload';

export interface PrivateOrderTransactionCommand {
  idempotencyKey: string;
  order: PrivateOrder;
  items: PrivateOrderItem[];
  baseOrder?: PrivateOrder;
  baseItems: PrivateOrderItem[];
  remove?: boolean;
}
export const PRIVATE_ORDER_RPC = 'erp_apply_private_order_transaction';
export function buildPrivateOrderRequest(command: PrivateOrderTransactionCommand) {
  if (!command.order.customer_name.trim()) throw new Error('請填寫登記人。');
  if (command.items.some(i => !Number.isSafeInteger(i.quantity) || i.quantity <= 0
    || !Number.isFinite(i.amount) || i.amount < 0 || i.private_order_id !== command.order.id)) {
    throw new Error('數量須為正整數，金額不可為負數。');
  }
  if (!command.baseOrder && !command.items.length) throw new Error('請至少填寫一筆登記品項。');
  const parent = command.baseOrder ? [toCloudFieldRow('private_orders',command.baseOrder)] : [];
  const children = command.baseItems.map(i => toCloudFieldRow('private_order_items',i));
  return {
    family: 'private-order', action: command.remove ? 'delete' : command.baseOrder ? 'edit' : 'create',
    orderId: String(toCloudFieldRow('private_orders', command.order).id), expectedParentVersion: command.baseOrder?.version ?? null,
    expectedItems: children.map(i => ({ id:i.id,version:i.version })).sort((a,b)=>String(a.id).localeCompare(String(b.id))),
    orderOperations: buildCloudCollectionMutationPlan('private_orders',parent,
      command.remove ? [] : [toCloudFieldRow('private_orders',command.order)]),
    itemOperations: buildCloudCollectionMutationPlan('private_order_items',children,
      command.remove ? [] : command.items.map(i => toCloudFieldRow('private_order_items',i))),
  };
}

// Session-only intent and the exact request survive reload/response loss. They
// contain only this form's data; never a durable backup resource or credentials.
const intents = new Map<string, string>();
export function readFormIntent<T>(scope:string):T|undefined {
  const key=`erp_saveability_intent_v1:${scope}`;
  let prior=intents.get(key);
  try { prior=sessionStorage.getItem(key)??prior; } catch { /* memory fallback */ }
  if(prior){ try{return JSON.parse(prior).command as T;}catch{/* invalid pending intent */} }
}
export function stableFormIntent<T>(scope: string, draft: unknown, factory: (key:string)=>T): T {
  const key=`erp_saveability_intent_v1:${scope}`;
  const fingerprint=JSON.stringify(draft);
  let prior=intents.get(key);
  try { prior=sessionStorage.getItem(key) ?? prior; } catch { /* Browser storage may be disabled. */ }
  if(prior){ try { const stored=JSON.parse(prior); if(stored.fingerprint===fingerprint) return stored.command as T; } catch { /* Replace invalid session-only intent before sending. */ } }
  const command=factory(crypto.randomUUID());
  const value=JSON.stringify({fingerprint,command});
  intents.set(key,value);
  try { sessionStorage.setItem(key,value); } catch { /* In-memory intent remains stable for this session. */ }
  return command;
}
export function clearFormIntent(scope:string):void {
  const key=`erp_saveability_intent_v1:${scope}`; intents.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* No persistent intent to clear. */ }
}

/** Local provider uses the same desired-state contract, inside one storage transaction. */
export function mergePrivateOrderState(orders:PrivateOrder[], items:PrivateOrderItem[], command:PrivateOrderTransactionCommand) {
  const current=orders.find(o=>o.id===command.order.id);
  const scoped=items.filter(i=>i.private_order_id===command.order.id);
  const sorted=(rows:PrivateOrderItem[])=>[...rows].sort((a,b)=>a.id.localeCompare(b.id));
  const desired=command.remove ? undefined : command.order;
  const desiredItems=command.remove ? [] : command.items;
  // Retry an already committed identical local intent, without duplicating rows.
  if(JSON.stringify(current)===JSON.stringify(desired) && JSON.stringify(sorted(scoped))===JSON.stringify(sorted(desiredItems))) return {orders,items};
  if(JSON.stringify(current)!==JSON.stringify(command.baseOrder)
    || JSON.stringify(sorted(scoped))!==JSON.stringify(sorted(command.baseItems))) throw new Error('私下登記已更新，請重新開啟確認；草稿未覆蓋資料。');
  if(!command.order.customer_name.trim() || desiredItems.some(i=>i.private_order_id!==command.order.id
    || !Number.isSafeInteger(i.quantity) || i.quantity<=0 || !Number.isFinite(i.amount) || i.amount<0)
    || (!command.baseOrder && !desiredItems.length)) throw new Error('請確認登記人、正整數數量與非負金額。');
  return {orders:[...orders.filter(o=>o.id!==command.order.id), ...(desired ? [desired] : [])],
    items:[...items.filter(i=>i.private_order_id!==command.order.id), ...desiredItems]};
}
