import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { supabase } from '../providers/cloud/supabaseClient';
import { Box, Lock, Mail } from 'lucide-react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) {
      navigate('/', { replace: true });
    }
  }, [user, loading, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) throw signInError;
      
      // Redirect on success
      if (data?.session || data?.user) {
        navigate('/', { replace: true });
      }
    } catch (err: any) {
      setError(err.message || '登入失敗，請檢查您的帳號與密碼。');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '80vh',
      padding: '24px'
    }}>
      <div className="card flex-col" style={{
        maxWidth: '400px',
        width: '100%',
        padding: '32px',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        backgroundColor: '#fff'
      }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{
            width: '48px', height: '48px', backgroundColor: 'var(--color-primary)',
            borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
            margin: '0 auto 16px auto'
          }}>
            <Box size={24} />
          </div>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>小河馬訂購紀錄表</h2>
          <p className="text-muted text-sm" style={{ margin: '4px 0 0 0' }}>登入雲端工作台</p>
        </div>

        {error && (
          <div style={{
            padding: '12px',
            backgroundColor: '#FEF2F2',
            border: '1px solid #FEE2E2',
            color: 'var(--color-danger)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '13px',
            marginBottom: '16px',
            lineHeight: 1.5
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="flex-col gap-md">
          <div className="flex-col gap-xs">
            <label className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>電子郵件</label>
            <div style={{ position: 'relative' }}>
              <Mail size={16} style={{ position: 'absolute', left: '12px', top: '12px', color: 'var(--color-text-muted)' }} />
              <input
                type="email"
                required
                placeholder="email@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 12px 10px 38px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border)',
                  outline: 'none',
                  fontSize: '14px'
                }}
              />
            </div>
          </div>

          <div className="flex-col gap-xs">
            <label className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>密碼</label>
            <div style={{ position: 'relative' }}>
              <Lock size={16} style={{ position: 'absolute', left: '12px', top: '12px', color: 'var(--color-text-muted)' }} />
              <input
                type="password"
                required
                placeholder="請輸入密碼"
                value={password}
                onChange={e => setPassword(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 12px 10px 38px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border)',
                  outline: 'none',
                  fontSize: '14px'
                }}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="btn btn-primary"
            style={{ width: '100%', padding: '12px', fontWeight: 600, marginTop: '8px' }}
          >
            {isLoading ? '正在登入...' : '登入'}
          </button>
        </form>
      </div>
    </div>
  );
}
