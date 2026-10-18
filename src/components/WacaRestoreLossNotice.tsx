import type { WacaRestoreLossReport } from '../waca/restoreLoss';

/**
 * Restore pre-check display: WACA work in the current ERP2 that the selected backup does not contain.
 * The Restore replaces it atomically and never re-applies it afterwards, so the Owner must confirm
 * explicitly (and should download a current backup first) before 確認還原 is accepted.
 */
export function WacaRestoreLossNotice({ report, acknowledged, onAcknowledge }: {
  report: WacaRestoreLossReport | null;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
}) {
  if (!report) return null;
  if (!report.atRisk) {
    return <p data-testid="cloud-restore-waca-loss-none" style={{ margin: '4px 0' }}>
      WACA：目前沒有這份備份未包含的訂單或認列紀錄。{report.backupHasNoLedger
        ? '此備份沒有 WACA 訂單帳本，還原後會保留備份中的 WACA 數量，下次匯入時建立新的接管基準。' : ''}
    </p>;
  }
  const sample = report.itemsAtRisk.slice(0, 8);
  return <div data-testid="cloud-restore-waca-loss" role="alert"
    style={{ margin: '10px 0', padding: 10, border: '1px solid #fca5a5', borderRadius: 8, background: '#fef2f2' }}>
    <strong>注意：還原會移除目前 ERP2 這份備份沒有的 WACA 資料</strong>
    <p style={{ margin: '6px 0' }}>
      備份未包含的訂單 {report.ordersNotInBackup} 張、明細或認列狀態不同 {report.itemsAtRisk.length} 筆
      （其中已計入 WACA 數量 {report.countedQuantityAtRisk} 件）、匯入紀錄 {report.batchesNotInBackup.length} 筆。
      還原後不會自動補回，也不會把舊的認列結果重新加回。
    </p>
    {report.backupHasNoLedger && <p style={{ margin: '6px 0' }}>
      此備份沒有 WACA 訂單帳本（ERP1 備份）：還原後 WACA 數量回到備份中的歷史數量，下次匯入時建立新的接管基準。
    </p>}
    {!!sample.length && <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
      {sample.map(item => <li key={item.itemKey}>訂單 {item.orderNumber}：已計入 {item.countedQuantity} 件
        {item.reason === 'COUNTED_DIFFERENT_IN_BACKUP' ? '（備份中的認列狀態不同）' : '（備份中沒有此訂單）'}</li>)}
      {report.itemsAtRisk.length > sample.length && <li>其餘 {report.itemsAtRisk.length - sample.length} 筆略</li>}
    </ul>}
    <p style={{ margin: '6px 0' }}>建議先在「資料備份」下載目前的雲端完整備份，保留差異證據後再還原。</p>
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <input type="checkbox" data-testid="cloud-restore-waca-loss-ack" checked={acknowledged}
        onChange={event => onAcknowledge(event.target.checked)} />
      <span>我已確認上述 WACA 資料會被這份備份取代，並已保留目前備份。</span>
    </label>
    {!acknowledged && <p style={{ margin: '6px 0', color: '#b91c1c' }}>勾選確認後才能還原。</p>}
  </div>;
}
