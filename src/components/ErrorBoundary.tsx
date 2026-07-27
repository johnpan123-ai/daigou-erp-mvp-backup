import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
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
        </div>
      );
    }

    return this.props.children;
  }
}
