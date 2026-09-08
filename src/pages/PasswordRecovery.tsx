import { useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Lock } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { formatRecoveryError } from '../auth/authErrors';

export default function PasswordRecovery() {
  const { authFlow, loading, setNewPassword } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!password || !confirmation) {
      setError('請輸入新密碼並再次確認。');
      return;
    }
    if (password !== confirmation) {
      setError('兩次輸入的密碼不一致。');
      return;
    }

    setSubmitting(true);
    try {
      await setNewPassword(password);
    } catch (caughtError: unknown) {
      setError(formatRecoveryError(caughtError));
      setSubmitting(false);
    }
  };

  const waiting = loading || authFlow === 'checking-recovery';
  const invalid = !waiting && authFlow !== 'recovery';

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '80vh', padding: '24px' }}>
      <div className="card flex-col" style={{ maxWidth: '420px', width: '100%', padding: '32px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', backgroundColor: '#fff' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{ width: '48px', height: '48px', backgroundColor: 'var(--color-primary)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', margin: '0 auto 16px' }}>
            <KeyRound size={24} />
          </div>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>設定新密碼</h2>
          <p className="text-muted text-sm" style={{ margin: '6px 0 0' }}>此頁只接受有效的密碼重設連結。</p>
        </div>

        {waiting && <div role="status" className="text-muted text-sm" style={{ textAlign: 'center' }}>正在驗證重設連結...</div>}

        {invalid && (
          <div className="flex-col gap-md">
            <div role="alert" style={{ padding: '12px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 'var(--radius-sm)', fontSize: '13px', lineHeight: 1.5 }}>
              密碼重設連結已失效或無效，請回登入頁重新申請。
            </div>
            <Link to="/login" className="btn btn-primary" style={{ width: '100%', padding: '12px', textAlign: 'center', textDecoration: 'none' }}>
              回登入頁
            </Link>
          </div>
        )}

        {!waiting && authFlow === 'recovery' && (
          <form onSubmit={handleSubmit} className="flex-col gap-md">
            {error && <div role="alert" style={{ padding: '12px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 'var(--radius-sm)', fontSize: '13px' }}>{error}</div>}
            <label className="flex-col gap-xs text-xs font-semibold">
              新密碼
              <span style={{ position: 'relative' }}>
                <Lock size={16} style={{ position: 'absolute', left: '12px', top: '12px', color: 'var(--color-text-muted)' }} />
                <input aria-label="新密碼" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} style={{ width: '100%', padding: '10px 12px 10px 38px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)' }} />
              </span>
            </label>
            <label className="flex-col gap-xs text-xs font-semibold">
              再次確認
              <span style={{ position: 'relative' }}>
                <Lock size={16} style={{ position: 'absolute', left: '12px', top: '12px', color: 'var(--color-text-muted)' }} />
                <input aria-label="再次確認" type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} style={{ width: '100%', padding: '10px 12px 10px 38px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)' }} />
              </span>
            </label>
            <button type="submit" disabled={submitting} className="btn btn-primary" style={{ width: '100%', padding: '12px', fontWeight: 600 }}>
              {submitting ? '正在更新...' : '設定新密碼'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
