import { useState } from 'react';
import { useAuth } from '../auth/authContext';
import { dataProvider } from '../providers/dataProvider';
import type { ProductVariant } from '../lib/db';
import { isEffectiveWacaStatus, type WacaItem, type WacaOrder } from './orderCore';
import type { NextWacaSnapshot, WacaBatch } from './nextStorage';
import { commitAndVerifyWacaRecognition, recognitionErrorMessage, recognitionMode, RECOGNITION_LABELS,
  type WacaRecognitionMode, type WacaRecognitionPlan, type WacaRecognitionRequest } from './recognitionManagement';
import { classifyWacaError, type WacaUiError } from './importErrors';

/** Real product UI. No direct table/quantity writes and no optimistic recognition. */
export function OrderRecognitionManager({ order, items, variants, batches, enabled, driven, onWriteStateChange, onCommitted }: {
  order: WacaOrder; items: WacaItem[]; variants: Map<string, ProductVariant>; enabled: boolean;
  batches: WacaBatch[];
  driven: boolean; onWriteStateChange: (submitting: boolean) => void;
  onCommitted: (snapshot: NextWacaSnapshot, variants: ProductVariant[]) => Promise<void>;
}) {
  const { profile } = useAuth();
  const [choices, setChoices] = useState<Record<string, WacaRecognitionMode>>({});
  const [reason, setReason] = useState('');
  const [review, setReview] = useState<{ request: WacaRecognitionRequest; plan: WacaRecognitionPlan } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<WacaUiError | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const allowed = enabled && profile?.role === 'owner' && profile.is_active;
  const countedQuantity = (item: WacaItem) => item.countedQuantity ?? (driven && isEffectiveWacaStatus(order.status) ? item.quantity : 0);
  const preview = async () => {
    setBusy(true); setReview(null); setError(null); setMessage('');
    try {
      const [snapshot, epoch] = await Promise.all([dataProvider.getNextWacaSnapshot(), dataProvider.readWacaRestoreEpoch()]);
      const request: WacaRecognitionRequest = { requestId: crypto.randomUUID(), orderKey: order.key, reason: reason.trim(),
        revision: snapshot.revision, restoreEpoch: epoch.epoch,
        choices: Object.entries(choices).map(([itemKey, mode]) => ({ itemKey, mode })) };
      const plan = await dataProvider.previewWacaRecognition(request);
      setReview({ request, plan });
      if (!plan.lines.length) setMessage('沒有實際差異，不會產生寫入或新增紀錄。');
    } catch (cause) { setMessage(recognitionErrorMessage(cause)); setError(classifyWacaError(cause, 'validation')); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!review || busy || uncertain) return;
    setBusy(true); setError(null); setMessage('');
    onWriteStateChange(true);
    let stage: 'commit' | 'readback' = 'commit';
    try {
      const verified = await commitAndVerifyWacaRecognition(dataProvider, review.request, review.plan, value => { stage = value; });
      await onCommitted(verified.snapshot, verified.variants);
      setChoices({}); setReview(null); setReason('');
      setMessage('認列調整已保存，來源訂單、認列紀錄及商品數量已權威讀回確認。');
    } catch (cause) {
      const classified = classifyWacaError(cause, stage, review.request.requestId, 'erp_commit_waca_recognition');
      setError(classified); setMessage(recognitionErrorMessage(cause));
      // A transport/refresh ambiguity must never turn the button into a write retry.
      setUncertain(classified.category !== 'WACA_COMMIT_REJECTED' && classified.category !== 'STALE_CONFLICT');
      if (classified.category === 'WACA_COMMIT_REJECTED' || classified.category === 'STALE_CONFLICT') setReview(null);
    } finally { onWriteStateChange(false); setBusy(false); }
  };
  const reconcile = async () => {
    if (!review) return;
    setBusy(true);
    onWriteStateChange(true);
    try {
      // Inject only a read-only receipt outcome; the verifier cannot replay RPC.
      const verified = await commitAndVerifyWacaRecognition({
        commitWacaRecognition: async () => { throw new Error('READ_ONLY_RECONCILE'); },
        getNextWacaSnapshot: () => dataProvider.getNextWacaSnapshot(),
        getAuthoritativeWacaVariants: () => dataProvider.getAuthoritativeWacaVariants(),
        readWacaRestoreEpoch: () => dataProvider.readWacaRestoreEpoch(),
      }, review.request, review.plan);
      await onCommitted(verified.snapshot, verified.variants);
      setUncertain(false); setReview(null); setChoices({}); setError(null);
      setMessage('既有認列調整已確認提交；沒有重送。');
    } catch { setMessage('尚無法確認結果，請保留此頁與請求編號，不要重新提交。'); }
    finally { onWriteStateChange(false); setBusy(false); }
  };
  return <div className="waca-recognition-manager" aria-label={`管理訂單 ${order.orderNumber}`}>
    <p>這是訂單明細的認列方式，不是匯入的「覆蓋／累加／維持」。選擇後先預覽，確認才會保存。</p>
    {!allowed && <p role="note">此管理功能僅限雲端 Owner；本機 NEXT 保留認列證據但不提供雲端調整。</p>}
    <div className="waca-scroll"><table><thead><tr><th>商品／規格</th><th>SKU</th><th>來源數量</th><th>已認列</th><th>目前狀態</th><th>調整認列</th></tr></thead>
      <tbody>{items.map(item => <tr key={item.key}>
        <td>{item.productTitle}<small>{item.spec1} {item.spec2}</small></td>
        <td>{variants.get(item.productVariantId ?? '')?.myacg_item_code ?? '未配對'}</td>
        <td>{item.quantity}</td><td>{countedQuantity(item)}</td>
        <td>{RECOGNITION_LABELS[recognitionMode(item, countedQuantity(item))]}
          {batches.some(b => b.recognition?.plan.lines.some(l => l.itemKey === item.key)) && <details className="waca-tech"><summary>認列紀錄</summary>
            {batches.filter(b => b.recognition?.plan.lines.some(l => l.itemKey === item.key)).map(b => {
              const evidence = b.recognition!, line = evidence.plan.lines.find(l => l.itemKey === item.key)!;
              return <p key={b.id}>Owner · {new Date(evidence.at).toLocaleString('zh-TW')}<br />
                {RECOGNITION_LABELS[line.beforeMode]} → {RECOGNITION_LABELS[line.mode]}（{line.countedBefore} → {line.countedAfter}）<br />{evidence.request.reason}</p>;
            })}</details>}
          {item.countedReview && item.countedReview !== 'OWNER_HOLD' && <small className="waca-recognition-warning">來源／認列證據需重新核對</small>}
          {!isEffectiveWacaStatus(order.status) && <small>訂單已取消／失敗，不可新增計入</small>}</td>
        <td><select aria-label={`認列 ${order.orderNumber} ${variants.get(item.productVariantId ?? '')?.myacg_item_code ?? item.key}`}
          value={choices[item.key] ?? recognitionMode(item, countedQuantity(item))} disabled={!allowed || busy || uncertain || !item.productVariantId}
          onChange={event => { setChoices({ ...choices, [item.key]: event.target.value as WacaRecognitionMode }); setReview(null); setError(null); setMessage(''); }}>
          {Object.entries(RECOGNITION_LABELS).map(([mode, label]) => <option key={mode} value={mode}
            disabled={mode === 'COUNT' && !isEffectiveWacaStatus(order.status)}>{label}</option>)}
        </select></td>
      </tr>)}</tbody></table></div>
    <label className="waca-recognition-reason">調整原因（必填）<input aria-label="認列調整原因" value={reason} maxLength={500}
      disabled={!allowed || busy || uncertain} onChange={event => { setReason(event.target.value); setReview(null); }} placeholder="例如：此訂單已包含在原本歷史數量" /></label>
    <button type="button" className="btn btn-md btn-secondary" disabled={!allowed || busy || uncertain || !Object.keys(choices).length || !reason.trim()}
      onClick={() => void preview()}>預覽認列調整</button>
    {review && review.plan.lines.length > 0 && <section className="waca-recognition-review" aria-label="認列調整預覽">
      <h3>確認這次調整</h3>
      <p>僅調整以下 {review.plan.lines.length} 筆訂單明細；來源訂單與舊認列證據會保留。</p>
      <ul>{review.plan.lines.map(line => <li key={line.itemKey}>{line.sku}：{RECOGNITION_LABELS[line.beforeMode]} → {RECOGNITION_LABELS[line.mode]}；已認列 {line.countedBefore} → {line.countedAfter}</li>)}</ul>
      {review.plan.quantities.map(q => <p key={q.variantId}><strong>{q.sku} WACA：{q.before} → {q.after}（{q.delta > 0 ? '+' : ''}{q.delta}）</strong></p>)}
      <p>「已含原本數量」不會再次累加；「暫不計入」會保留待處理紀錄。計入前請確認未包含在其他歷史數量中。</p>
      <button type="button" className="btn btn-md btn-primary" disabled={!allowed || busy || uncertain} onClick={() => void confirm()}>確認保存認列調整</button>
    </section>}
    {uncertain && <button type="button" className="btn btn-md btn-secondary" disabled={busy} onClick={() => void reconcile()}>重新讀取結果（不重送）</button>}
    {message && <p role="status">{message}</p>}
    {error && <details className="waca-tech"><summary>技術資訊</summary>{error.diagnostic?.reason}／{error.diagnostic?.code}／{error.diagnostic?.rpc}／{error.diagnostic?.requestId}</details>}
  </div>;
}
