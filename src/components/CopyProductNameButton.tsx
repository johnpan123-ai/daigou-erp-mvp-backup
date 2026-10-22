import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

export const CopyProductNameButton = ({ name, groupId }: { name: string; groupId: string }) => {
  const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'failure'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);

  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
      <button
        type="button"
        data-testid={`copy-japan-package-group-${groupId}`}
        disabled={status === 'pending'}
        onClick={async event => {
          event.stopPropagation();
          if (pending.current) return;
          pending.current = true;
          clearTimeout(timer.current);
          setStatus('pending');
          try {
            await navigator.clipboard.writeText(name);
            if (mounted.current) {
              setStatus('success');
              timer.current = setTimeout(() => setStatus('idle'), 1600);
            }
          } catch {
            if (mounted.current) setStatus('failure');
          } finally {
            pending.current = false;
          }
        }}
        style={{ minHeight: 44, minWidth: 112, padding: '6px 12px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', color: '#334155', cursor: 'pointer', whiteSpace: 'normal' }}
      >
        {status === 'success' ? '✓ 已複製' : status === 'pending' ? '複製中…' : '複製商品名稱'}
      </button>
      <span role="status" style={{ fontSize: 12, color: status === 'failure' ? '#b91c1c' : '#15803d' }}>
        {status === 'failure' ? '複製失敗，請再試一次。' : ''}
      </span>
    </span>
  );
};

// Compact icon variant for the mobile receiving card: a 44px touch target around a small icon that
// briefly turns into a green check after copying, and no click propagation to the card's toggle.
export const CopyProductNameIconButton = ({ name, groupId }: { name: string; groupId: string }) => {
  const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'failure'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);
  const hint = status === 'success' ? '已複製' : status === 'failure' ? '複製失敗' : '';

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        data-testid={`copy-japan-package-group-${groupId}`}
        aria-label={`複製商品名稱：${name}`}
        title="複製商品名稱"
        disabled={status === 'pending'}
        onClick={async event => {
          event.stopPropagation();
          if (pending.current) return;
          pending.current = true;
          clearTimeout(timer.current);
          setStatus('pending');
          try {
            await navigator.clipboard.writeText(name);
            if (mounted.current) setStatus('success');
          } catch {
            if (mounted.current) setStatus('failure');
          } finally {
            pending.current = false;
            if (mounted.current) timer.current = setTimeout(() => setStatus('idle'), 1600);
          }
        }}
        style={{ width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 'none', background: 'transparent', color: status === 'success' ? '#15803d' : status === 'failure' ? '#b91c1c' : '#64748b', cursor: 'pointer', borderRadius: 8 }}
      >
        {status === 'success' ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
      </button>
      {/* Feedback is the icon itself (green check); the text is for screen readers only, so nothing shifts. */}
      <span role="status" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
        {hint}
      </span>
    </span>
  );
};
