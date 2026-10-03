import type { ImportStats } from '../lib/db';

interface BuyAnimeImportSuccessDialogProps {
  stats: ImportStats | null;
  cloudSynced: boolean;
  onClose: () => void;
}

export function BuyAnimeImportSuccessDialog({ stats, cloudSynced, onClose }: BuyAnimeImportSuccessDialogProps) {
  if (!stats) return null;
  return (
    <div className="modal-overlay active" role="presentation" data-testid="buyanime-import-success-modal">
      <section className="modal-content" role="dialog" aria-modal="true" aria-labelledby="buyanime-import-success-title">
        <h2 id="buyanime-import-success-title" style={{ marginTop: 0 }}>匯入成功</h2>
        <p>已完成買動漫商品更新與{cloudSynced ? '雲端同步' : '本機同步'}。</p>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 18px', margin: '20px 0' }}>
          <dt>新增</dt><dd style={{ margin: 0, fontWeight: 700 }}>{stats.newCount}</dd>
          <dt>更新</dt><dd style={{ margin: 0, fontWeight: 700 }}>{stats.updatedCount}</dd>
          <dt>未變更</dt><dd style={{ margin: 0, fontWeight: 700 }}>{stats.unchangedCount}</dd>
          <dt>處理筆數</dt><dd style={{ margin: 0, fontWeight: 700 }}>{stats.total}</dd>
        </dl>
        <p style={{ color: '#047857', fontWeight: 700 }}>
          {cloudSynced ? '雲端資料已同步完成。' : '本機資料已同步完成。'}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>確定</button>
        </div>
      </section>
    </div>
  );
}
