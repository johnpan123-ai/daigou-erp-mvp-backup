import { useEffect, useState } from 'react';
import { getProviderMode } from '../../providers/providerMode';
import { supabaseEnvironment } from '../../providers/cloud/supabaseClient';
import { ERP_SYSTEM_NAME, ERP_SYSTEM_VERSION } from './erpSystemIdentity';

const unavailable = '未提供';
const exactErp2Domain = 'hippo-erp-realtime-preview.pages.dev';

export type SystemInformationRow = { label: string; value: string };

function getSystemInformationRows(publicFingerprint = unavailable): SystemInformationRow[] {
  const mode = getProviderMode();
  const runtime = mode === 'local' ? 'Local' : mode === 'cloud' ? 'ERP 2.0 Cloud' : mode.toUpperCase();
  const project = window.location.hostname === exactErp2Domain ? 'hippo-erp-realtime-preview' : unavailable;
  return [
    { label: 'System', value: ERP_SYSTEM_NAME },
    { label: 'Version', value: ERP_SYSTEM_VERSION },
    { label: 'Build SHA', value: import.meta.env.VITE_ERP_BUILD_SHA || unavailable },
    { label: 'Build Time', value: import.meta.env.VITE_ERP_BUILD_TIME || unavailable },
    { label: 'Runtime', value: runtime },
    { label: 'Cloudflare Project', value: project },
    { label: 'Supabase Project', value: supabaseEnvironment.projectRef || unavailable },
    { label: 'Public Fingerprint', value: publicFingerprint },
    { label: 'Deployment ID', value: import.meta.env.VITE_ERP_DEPLOYMENT_ID || unavailable },
    { label: 'Accepted Baseline Tag', value: import.meta.env.VITE_ERP_ACCEPTED_TAG || unavailable },
    { label: 'Database Epoch', value: unavailable },
    { label: 'Restore', value: '041 / 042 / 043（前端契約）' },
    { label: 'Deadline Lookup', value: 'v1' },
  ];
}

export function SystemInformation() {
  const [fingerprint, setFingerprint] = useState(unavailable);
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'failure'>('idle');

  useEffect(() => {
    if (getProviderMode() !== 'cloud' || !import.meta.env.VITE_SUPABASE_ANON_KEY || !crypto.subtle) return;
    let active = true;
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(import.meta.env.VITE_SUPABASE_ANON_KEY))
      .then(bytes => {
        if (active) setFingerprint(Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16).toUpperCase());
      })
      .catch(() => { /* An unavailable fingerprint must never be guessed. */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const rows = getSystemInformationRows(fingerprint);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rows.map(row => `${row.label}: ${row.value}`).join('\n'));
      setCopyState('success');
    } catch {
      setCopyState('failure');
    }
  };

  return (
    <section className="card settings-system-info" aria-label="系統資訊">
      <div className="settings-section-heading">
        <div>
          <h2>系統資訊</h2>
          <p>僅顯示可安全分享的環境與版本資訊；未提供的部署資料不會猜測。</p>
        </div>
        <button type="button" className="btn btn-outline" onClick={copy}>
          {copyState === 'success' ? '✓ 已複製' : copyState === 'failure' ? '複製失敗，請再試一次' : '複製系統資訊'}
        </button>
      </div>
      <dl className="settings-system-info-grid">
        {rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
      </dl>
    </section>
  );
}
