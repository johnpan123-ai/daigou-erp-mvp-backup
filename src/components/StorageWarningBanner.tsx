import { useEffect, useState } from 'react';
import { onStorageWarning, clearStorageWarning, checkLocalStorageWritable } from '../lib/storageGuard';

export function StorageWarningBanner() {
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    checkLocalStorageWritable();
    return onStorageWarning(setWarning);
  }, []);

  if (!warning) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 10000,
      backgroundColor: '#fef2f2',
      borderTop: '2px solid #ef4444',
      padding: '12px 20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      fontSize: '14px',
      color: '#991b1b',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <span>{warning}</span>
      <button
        onClick={() => clearStorageWarning()}
        style={{
          background: 'none',
          border: '1px solid #fca5a5',
          borderRadius: '6px',
          padding: '4px 12px',
          fontSize: '13px',
          color: '#991b1b',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        知道了
      </button>
    </div>
  );
}
