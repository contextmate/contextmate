import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import {
  deriveKeyFromPassphrase,
  deriveSubKey,
  hashForAuth,
  hexToBytes,
  bytesToHex,
} from '../crypto/browser-crypto.ts';
import { ApiClient } from '../api/client.ts';

const SESSION_KEY = 'contextmate-session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface StoredSession {
  token: string;
  userId: string;
  serverUrl: string;
  vaultKeyRaw: string; // hex
  authKeyHex: string;
  expiresAt: number;
}

function saveSession(s: StoredSession): void {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* quota */ }
}

function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s: StoredSession = JSON.parse(raw);
    if (Date.now() > s.expiresAt) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

interface AuthState {
  isAuthenticated: boolean;
  vaultKey: CryptoKey | null;
  vaultKeyRaw: Uint8Array | null;
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

async function importVaultKey(rawBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    rawBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    vaultKey: null,
    vaultKeyRaw: null,
    authKeyHex: null,
    token: null,
    userId: null,
    apiClient: null,
    serverUrl: '',
    sessionExpired: false,
  });

  // Restore session from localStorage on mount
  useEffect(() => {
    const stored = loadSession();
    if (!stored) return;

    (async () => {
      try {
        const vaultKeyRaw = hexToBytes(stored.vaultKeyRaw);
        const vaultKey = await importVaultKey(vaultKeyRaw);

        const client = new ApiClient(stored.serverUrl);
        client.setToken(stored.token);
        client.onUnauthorized = () => {
          clearSession();
          setState((prev) => ({
            ...prev,
            isAuthenticated: false,
            vaultKey: null,
            vaultKeyRaw: null,
            authKeyHex: null,
            token: null,
            apiClient: null,
            sessionExpired: true,
          }));
        };

        setState({
          isAuthenticated: true,
          vaultKey,
          vaultKeyRaw,
          authKeyHex: stored.authKeyHex,
          token: stored.token,
          userId: stored.userId,
          apiClient: client,
          serverUrl: stored.serverUrl,
          sessionExpired: false,
        });
      } catch {
        clearSession();
      }
    })();
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setState({
      isAuthenticated: false,
      vaultKey: null,
      vaultKeyRaw: null,
      authKeyHex: null,
      token: null,
      userId: null,
      apiClient: null,
      serverUrl: '',
      sessionExpired: false,
    });
  }, []);

  const login = useCallback(async (passphrase: string, serverUrl: string, userId: string) => {
    const client = new ApiClient(serverUrl);

    // Wire up 401 detection to trigger session expiry
    client.onUnauthorized = () => {
      clearSession();
      setState((prev) => ({
        ...prev,
        isAuthenticated: false,
        vaultKey: null,
        vaultKeyRaw: null,
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

    // Derive vault sub-key for encryption (info must match CLI: 'contextmate-vault-enc')
    const { key: vaultKey, rawKey: vaultKeyRaw } = await deriveSubKey(rawKey, 'contextmate-vault-enc');

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

    // Persist session to localStorage
    saveSession({
      token,
      userId: confirmedUserId,
      serverUrl,
      vaultKeyRaw: bytesToHex(vaultKeyRaw),
      authKeyHex: authKeyHash,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    setState({
      isAuthenticated: true,
      vaultKey,
      vaultKeyRaw,
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
