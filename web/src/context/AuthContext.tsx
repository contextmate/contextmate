import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import {
  deriveKeyFromPassphrase,
  deriveSubKey,
  hashForAuth,
  hexToBytes,
} from '../crypto/browser-crypto.ts';
import { ApiClient } from '../api/client.ts';

interface AuthState {
  isAuthenticated: boolean;
  vaultKey: CryptoKey | null;
  authKeyHex: string | null;
  token: string | null;
  userId: string | null;
  apiClient: ApiClient | null;
  serverUrl: string;
  sessionExpired: boolean;
}

interface AuthContextValue extends AuthState {
  login: (passphrase: string, serverUrl: string, userId: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    vaultKey: null,
    authKeyHex: null,
    token: null,
    userId: null,
    apiClient: null,
    serverUrl: '',
    sessionExpired: false,
  });

  const logout = useCallback(() => {
    setState((prev) => ({
      isAuthenticated: false,
      vaultKey: null,
      authKeyHex: null,
      token: null,
      userId: null,
      apiClient: null,
      serverUrl: '',
      sessionExpired: prev.sessionExpired,
    }));
  }, []);

  const login = useCallback(async (passphrase: string, serverUrl: string, userId: string) => {
    const client = new ApiClient(serverUrl);

    // Wire up 401 detection to trigger session expiry
    client.onUnauthorized = () => {
      setState((prev) => ({
        ...prev,
        isAuthenticated: false,
        vaultKey: null,
        authKeyHex: null,
        token: null,
        apiClient: null,
        sessionExpired: true,
      }));
    };

    // Fetch the user's per-user salt from the server
    const saltHex = await client.getSalt(userId);
    const salt = hexToBytes(saltHex);

    // Derive master key from passphrase using Argon2id + per-user salt
    const { rawKey } = await deriveKeyFromPassphrase(passphrase, salt);

    // Derive vault sub-key for encryption
    const { key: vaultKey } = await deriveSubKey(rawKey, 'contextmate-vault');

    // Derive auth sub-key for authentication
    const { rawKey: authRawKey } = await deriveSubKey(rawKey, 'contextmate-auth');

    // Zero out intermediate key material (best-effort in JS)
    rawKey.fill(0);

    // Hash auth key for server (BLAKE3)
    const authKeyHash = await hashForAuth(authRawKey);
    authRawKey.fill(0);

    // Authenticate with server
    const { userId: confirmedUserId, token } = await client.login(authKeyHash);
    client.setToken(token);

    setState({
      isAuthenticated: true,
      vaultKey,
      authKeyHex: authKeyHash,
      token,
      userId: confirmedUserId,
      apiClient: client,
      serverUrl,
      sessionExpired: false,
    });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
