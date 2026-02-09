import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  onLogout?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-card">
            <h1 className="error-boundary-title">Something went wrong</h1>
            <p className="error-boundary-message">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <div className="error-boundary-actions">
              <button
                className="login-button"
                onClick={() => window.location.reload()}
              >
                Reload
              </button>
              {this.props.onLogout && (
                <button
                  className="topbar-logout"
                  style={{ padding: '0.75rem 1.5rem', fontSize: '0.875rem' }}
                  onClick={this.props.onLogout}
                >
                  Logout
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
