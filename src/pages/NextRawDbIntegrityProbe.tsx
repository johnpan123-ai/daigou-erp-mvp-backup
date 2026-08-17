import { useEffect, useState } from 'react';
import {
  buildNextRawIntegrityReport,
  parseWorkbenchBackup,
  readNextRawCollections,
  readNextRawSnapshotMetadata,
  type NextRawCollections,
  type NextRawIntegrityReport,
} from '../lib/nextRawDbIntegrityProbe';
import { getActiveSandboxMode } from '../lib/testSandboxEnvironment';

export default function NextRawDbIntegrityProbe() {
  const [raw, setRaw] = useState<NextRawCollections | null>(null);
  const [report, setReport] = useState<NextRawIntegrityReport | null>(null);
  const [sourceText, setSourceText] = useState('');
  const [metadata, setMetadata] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([readNextRawCollections(), readNextRawSnapshotMetadata()])
      .then(([collections, snapshotMetadata]) => {
        setRaw(collections);
        setMetadata(snapshotMetadata);
      })
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  }, []);

  const handleSourceFile = async (file?: File) => {
    if (!file || !raw) return;
    setLoading(true);
    setError('');
    setReport(null);
    try {
      const source = parseWorkbenchBackup(await file.text());
      setReport(await buildNextRawIntegrityReport(source, raw));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const handleSourceText = async () => {
    if (!sourceText || !raw) return;
    setLoading(true);
    setError('');
    setReport(null);
    try {
      setReport(await buildNextRawIntegrityReport(parseWorkbenchBackup(sourceText), raw));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  if (getActiveSandboxMode() !== 'next') {
    return <div style={{ padding: 32, color: '#b91c1c' }}>此唯讀診斷頁只允許在 Next Sandbox 使用。</div>;
  }

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0 }}>P0-G/H Next Raw DB Integrity Probe</h1>
      <p style={{ color: '#475569' }}>
        直接讀取 <code>daigou-erp-db-next-v1</code>；IndexedDB transaction 固定為 <code>readonly</code>，不經 Provider／ViewModel。
      </p>
      <pre data-testid="next-snapshot-metadata" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
        {JSON.stringify(metadata, null, 2)}
      </pre>
      <label style={{ display: 'inline-flex', gap: 10, alignItems: 'center', padding: '12px 16px', border: '1px solid #94a3b8', borderRadius: 8 }}>
        來源 workbench JSON
        <input type="file" accept="application/json,.json" onChange={event => void handleSourceFile(event.target.files?.[0])} />
      </label>
      <details style={{ marginTop: 12 }}>
        <summary>診斷自動化用：貼上來源 JSON</summary>
        <textarea
          aria-label="來源 JSON 文字"
          value={sourceText}
          onChange={event => setSourceText(event.target.value)}
          style={{ display: 'block', width: '100%', minHeight: 80, marginTop: 8 }}
        />
        <button type="button" onClick={() => void handleSourceText()} disabled={!sourceText || !raw}>
          執行文字對照
        </button>
      </details>
      {loading && <p>讀取中…</p>}
      {error && <pre style={{ color: '#b91c1c', whiteSpace: 'pre-wrap' }}>{error}</pre>}
      {raw && !report && !loading && (
        <p style={{ color: '#166534' }}>Next raw DB 已唯讀取得。請選擇 Production workbench JSON 進行對照。</p>
      )}
      {report && (
        <>
          <h2>集合筆數／checksum</h2>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr><th>集合</th><th>JSON</th><th>Next raw</th><th>Hash</th></tr></thead>
            <tbody>
              {Object.entries(report.collectionCounts).map(([field, counts]) => (
                <tr key={field}>
                  <td>{field}</td><td>{counts.source}</td><td>{counts.nextRaw}</td>
                  <td>{report.collectionHashes[field as keyof NextRawCollections].equal ? '一致' : '不同'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>5 筆 VSPO</h2>
          {report.targetGroups.map(group => (
            <details key={group.id} style={{ border: '1px solid #cbd5e1', borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700 }}>
                {group.title || group.id}｜JSON WACA {group.source.totals.waca}／採購 {group.source.totals.purchased}
                {' → '}Raw WACA {group.nextRaw.totals.waca}／採購 {group.nextRaw.totals.purchased}
                {' '}({group.differences.length ? `${group.differences.length} 差異` : '一致'})
              </summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(group, null, 2)}</pre>
            </details>
          ))}

          <h2>Referential Integrity</h2>
          <p data-testid="orphan-gate">
            Import 後 orphan 增加：{report.referentialIntegrity.increasedRelations.length === 0 ? '否' : '是'}
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(report.referentialIntegrity, null, 2)}</pre>
          <h2>完整唯讀報告</h2>
          <pre data-testid="raw-integrity-report" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>{JSON.stringify(report, null, 2)}</pre>
        </>
      )}
    </div>
  );
}
