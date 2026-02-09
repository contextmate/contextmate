import { useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext.tsx';

export function Login() {
  const { login, sessionExpired } = useAuth();
  const [userId, setUserId] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [serverUrl, setServerUrl] = useState('https://api.contextmate.dev');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!passphrase.trim() || !userId.trim()) return;

    setLoading(true);
    setError(null);
    try {
      await login(passphrase, serverUrl, userId.trim());
      setPassphrase('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-container">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1 className="login-title">ContextMate</h1>
        <p className="login-subtitle">Unlock your encrypted vault</p>

        {sessionExpired && !error && (
          <div className="login-warning">Session expired. Please log in again.</div>
        )}
        {error && <div className="login-error">{error}</div>}

        <label className="login-label">
          Server URL
          <input
            type="url"
            className="login-input"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="https://api.contextmate.dev"
            autoComplete="url"
            disabled={loading}
          />
        </label>

        <label className="login-label">
          User ID
          <input
            type="text"
            className="login-input"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="Your user ID from CLI registration"
            autoComplete="off"
            disabled={loading}
          />
          <span className="login-hint">
            Run <code>contextmate status</code> in your CLI to find your user ID.
          </span>
        </label>

        <label className="login-label">
          Passphrase
          <input
            type="password"
            className="login-input"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Enter your vault passphrase"
            autoComplete="current-password"
            autoFocus
            disabled={loading}
          />
        </label>

        <button
          type="submit"
          className="login-button"
          disabled={loading || !passphrase.trim() || !userId.trim()}
        >
          {loading ? (
            <span className="login-spinner">Deriving keys...</span>
          ) : (
            'Unlock Vault'
          )}
        </button>
      </form>
    </div>
  );
}
