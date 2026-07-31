import { Component, type ReactNode } from 'react';

interface CrashEntry {
  time: string;
  error: string;
  stack?: string;
  componentStack?: string;
  context?: string;
}

declare global {
  interface Window {
    __erpCrashLog?: CrashEntry[];
  }
}

interface Props {
  children: ReactNode;
  resetKey?: string;
}

interface State {
  hasError: boolean;
  errorMessage: string;
  showLog: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, errorMessage: '', showLog: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { hasError: true, errorMessage: String(error) };
  }

  componentDidUpdate(prevProps: Props) {
    if (this.props.resetKey !== prevProps.resetKey && this.state.hasError) {
      this.setState({ hasError: false, errorMessage: '', showLog: false });
    }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    const entry: CrashEntry = {
      time: new Date().toISOString(),
      error: String(error),
      stack: (error as any)?.stack,
      componentStack: info.componentStack || undefined,
      context: 'ErrorBoundary',
    };
    console.error('[ErrorBoundary]', error, info.componentStack);

    window.__erpCrashLog = window.__erpCrashLog || [];
    window.__erpCrashLog.push(entry);

    try {
      const existing = JSON.parse(localStorage.getItem('erp_crash_log') || '[]');
      existing.push(entry);
      if (existing.length > 20) existing.splice(0, existing.length - 20);
      localStorage.setItem('erp_crash_log', JSON.stringify(existing));
    } catch { /* ignore storage errors */ }
  }

  render() {
    if (this.state.hasError) {
      const crashLog = (() => {
        try {
          return JSON.parse(localStorage.getItem('erp_crash_log') || '[]') as CrashEntry[];
        } catch { return []; }
      })();

      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: '16px',
          fontFamily: 'system-ui, sans-serif',
          color: '#334155',
          padding: '20px',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '48px' }}>:(</div>
          <h1 style={{ fontSize: '20px', margin: 0 }}>頁面發生錯誤</h1>
          <p style={{ color: '#64748b', margin: 0 }}>請重新整理頁面，如果問題持續請聯絡管理員</p>
          <pre style={{
            fontSize: '12px',
            color: '#94a3b8',
            maxWidth: '600px',
            overflow: 'auto',
            textAlign: 'left',
            padding: '8px',
            backgroundColor: '#f8fafc',
            borderRadius: '6px',
            border: '1px solid #e2e8f0',
            maxHeight: '80px',
          }}>
            {this.state.errorMessage}
          </pre>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '10px 24px',
                fontSize: '15px',
                border: 'none',
                borderRadius: '8px',
                background: '#3b82f6',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              重新整理
            </button>
            <button
              onClick={() => {
                localStorage.removeItem('erp_search_term');
                window.location.reload();
              }}
              style={{
                padding: '10px 24px',
                fontSize: '15px',
                border: '1px solid #cbd5e1',
                borderRadius: '8px',
                background: '#fff',
                color: '#334155',
                cursor: 'pointer',
              }}
            >
              清除搜尋並重整
            </button>
          </div>

          {crashLog.length > 0 && (
            <div style={{ marginTop: '16px', width: '100%', maxWidth: '700px' }}>
              <button
                onClick={() => this.setState({ showLog: !this.state.showLog })}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#64748b',
                  fontSize: '13px',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                {this.state.showLog ? '隱藏錯誤紀錄' : `查看錯誤紀錄 (${crashLog.length})`}
              </button>
              {this.state.showLog && (
                <div style={{
                  marginTop: '8px',
                  maxHeight: '300px',
                  overflow: 'auto',
                  textAlign: 'left',
                  fontSize: '11px',
                  backgroundColor: '#1e293b',
                  color: '#e2e8f0',
                  borderRadius: '8px',
                  padding: '12px',
                }}>
                  {crashLog.slice().reverse().map((entry, i) => (
                    <div key={i} style={{ marginBottom: '12px', borderBottom: '1px solid #334155', paddingBottom: '8px' }}>
                      <div style={{ color: '#94a3b8' }}>{entry.time} [{entry.context}]</div>
                      <div style={{ color: '#f87171', fontWeight: 600 }}>{entry.error}</div>
                      {entry.stack && (
                        <pre style={{ margin: '4px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#cbd5e1', fontSize: '10px' }}>
                          {entry.stack.split('\n').slice(0, 5).join('\n')}
                        </pre>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => {
                      localStorage.removeItem('erp_crash_log');
                      window.__erpCrashLog = [];
                      this.setState({ showLog: false });
                    }}
                    style={{
                      marginTop: '8px',
                      padding: '4px 12px',
                      fontSize: '11px',
                      border: '1px solid #475569',
                      borderRadius: '4px',
                      background: 'transparent',
                      color: '#94a3b8',
                      cursor: 'pointer',
                    }}
                  >
                    清除紀錄
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
