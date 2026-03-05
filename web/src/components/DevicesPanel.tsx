import { Fragment, useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.tsx';
import { encryptData, decryptData, bytesToHex, hexToBytes } from '../crypto/browser-crypto.ts';
import type { Device } from '../api/client.ts';

type SyncDirection = 'send-receive' | 'receive-only' | 'off';

interface AdapterSettings {
  enabled: boolean;
  syncDirection: SyncDirection;
}

interface DeviceSettings {
  scanPaths: string[];
  adapters: {
    claude: AdapterSettings;
    openclaw: AdapterSettings;
  };
}

const DEFAULT_ADAPTER: AdapterSettings = { enabled: true, syncDirection: 'send-receive' };

const DEFAULT_SETTINGS: DeviceSettings = {
  scanPaths: [],
  adapters: {
    claude: { ...DEFAULT_ADAPTER },
    openclaw: { ...DEFAULT_ADAPTER },
  },
};

const DIRECTION_MIGRATION: Record<string, SyncDirection> = {
  'bidirectional': 'send-receive',
  'pull-only': 'receive-only',
  'disabled': 'off',
};

function normalizeAdapter(raw: unknown): AdapterSettings {
  if (typeof raw === 'boolean') {
    // Migrate old format: boolean → AdapterSettings
    return { enabled: raw, syncDirection: 'send-receive' };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const dir = obj.syncDirection as string;
    const migrated = DIRECTION_MIGRATION[dir] ?? dir;
    return {
      enabled: Boolean(obj.enabled),
      syncDirection: (['send-receive', 'receive-only', 'off'].includes(migrated)
        ? migrated as SyncDirection
        : 'send-receive'),
    };
  }
  return { ...DEFAULT_ADAPTER };
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = Math.max(0, Math.floor((now - ts) / 1000));
  if (diff < 60) return `${diff} seconds ago`;
  const minutes = Math.floor(diff / 60);
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

async function decryptSettings(
  encryptedHex: string,
  vaultKey: CryptoKey
): Promise<DeviceSettings> {
  const encrypted = hexToBytes(encryptedHex);
  const plaintext = await decryptData(encrypted, vaultKey);
  const json = new TextDecoder().decode(plaintext);
  const parsed = JSON.parse(json);
  return {
    scanPaths: Array.isArray(parsed.scanPaths) ? parsed.scanPaths : [],
    adapters: {
      claude: normalizeAdapter(parsed.adapters?.claude),
      openclaw: normalizeAdapter(parsed.adapters?.openclaw),
    },
  };
}

async function encryptSettings(
  settings: DeviceSettings,
  vaultKey: CryptoKey
): Promise<string> {
  const json = JSON.stringify(settings);
  const plaintext = new TextEncoder().encode(json);
  const encrypted = await encryptData(plaintext, vaultKey);
  return bytesToHex(encrypted);
}

const ADAPTER_NAMES: Array<{ key: keyof DeviceSettings['adapters']; label: string }> = [
  { key: 'openclaw', label: 'OpenClaw' },
  { key: 'claude', label: 'Claude Code' },
];

function syncDirectionLabel(dir: SyncDirection): string {
  switch (dir) {
    case 'send-receive': return 'Send & Receive';
    case 'receive-only': return 'Receive only';
    case 'off': return 'Off';
  }
}

function syncDirectionBadgeClass(dir: SyncDirection): string {
  switch (dir) {
    case 'send-receive': return 'badge-active';
    case 'receive-only': return 'badge';
    case 'off': return 'badge-revoked';
  }
}

export function DevicesPanel() {
  const { apiClient, vaultKey } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const [editSettings, setEditSettings] = useState<DeviceSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newPath, setNewPath] = useState('');

  const fetchDevices = useCallback(async () => {
    if (!apiClient) return;
    try {
      setLoading(true);
      setError(null);
      const result = await apiClient.listDevices();
      setDevices(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const handleExpand = useCallback(
    async (deviceId: string) => {
      if (expandedDeviceId === deviceId) {
        setExpandedDeviceId(null);
        setEditSettings(null);
        setSettingsError(null);
        return;
      }

      setExpandedDeviceId(deviceId);
      setEditSettings(null);
      setSettingsError(null);
      setNewPath('');

      if (!apiClient || !vaultKey) return;

      const device = devices.find((d) => d.id === deviceId);
      if (!device) return;

      if (!device.encryptedSettings) {
        setEditSettings({ ...DEFAULT_SETTINGS });
        return;
      }

      try {
        setSettingsLoading(true);
        const settings = await decryptSettings(device.encryptedSettings, vaultKey);
        setEditSettings(settings);
      } catch (err) {
        setSettingsError(
          err instanceof Error ? err.message : 'Failed to decrypt device settings'
        );
      } finally {
        setSettingsLoading(false);
      }
    },
    [expandedDeviceId, apiClient, vaultKey, devices]
  );

  const handleSave = useCallback(
    async (deviceId: string) => {
      if (!apiClient || !vaultKey || !editSettings) return;

      try {
        setSaving(true);
        setSettingsError(null);
        const encryptedHex = await encryptSettings(editSettings, vaultKey);
        await apiClient.updateDeviceSettings(deviceId, encryptedHex);
        setDevices((prev) =>
          prev.map((d) =>
            d.id === deviceId ? { ...d, encryptedSettings: encryptedHex } : d
          )
        );
      } catch (err) {
        setSettingsError(
          err instanceof Error ? err.message : 'Failed to save device settings'
        );
      } finally {
        setSaving(false);
      }
    },
    [apiClient, vaultKey, editSettings]
  );

  const handleRemoveDevice = useCallback(
    async (deviceId: string, deviceName: string) => {
      if (!apiClient) return;
      if (!window.confirm(`Remove device "${deviceName}"? This cannot be undone.`)) return;

      try {
        setError(null);
        await apiClient.deleteDevice(deviceId);
        setDevices((prev) => prev.filter((d) => d.id !== deviceId));
        if (expandedDeviceId === deviceId) {
          setExpandedDeviceId(null);
          setEditSettings(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to remove device');
      }
    },
    [apiClient, expandedDeviceId]
  );

  const handleAddPath = useCallback(() => {
    const trimmed = newPath.trim();
    if (!trimmed || !editSettings) return;
    if (editSettings.scanPaths.includes(trimmed)) {
      setNewPath('');
      return;
    }
    setEditSettings({
      ...editSettings,
      scanPaths: [...editSettings.scanPaths, trimmed],
    });
    setNewPath('');
  }, [newPath, editSettings]);

  const handleRemovePath = useCallback(
    (index: number) => {
      if (!editSettings) return;
      setEditSettings({
        ...editSettings,
        scanPaths: editSettings.scanPaths.filter((_, i) => i !== index),
      });
    },
    [editSettings]
  );

  const handleSyncDirectionChange = useCallback(
    (adapter: keyof DeviceSettings['adapters'], direction: SyncDirection) => {
      if (!editSettings) return;
      setEditSettings({
        ...editSettings,
        adapters: {
          ...editSettings.adapters,
          [adapter]: {
            ...editSettings.adapters[adapter],
            enabled: direction !== 'off',
            syncDirection: direction,
          },
        },
      });
    },
    [editSettings]
  );

  if (loading) {
    return (
      <div className="panel">
        <div className="panel-header">Devices</div>
        <div className="panel-section">Loading devices...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel">
        <div className="panel-header">Devices</div>
        <div className="panel-section" style={{ color: '#ff6b6b' }}>
          {error}
        </div>
        <div className="panel-section">
          <button className="btn btn-secondary" onClick={fetchDevices}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-header">Devices</div>
      <div className="panel-section" style={{ opacity: 0.7, fontSize: '0.8125rem', marginBottom: '0.5rem' }}>
        Devices default to Send & Receive. Set to Receive only to prevent a device from pushing local changes.
      </div>

      {devices.length === 0 ? (
        <div className="panel-section">
          No devices registered yet. Connect a device using the CLI to get started.
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Last Seen</th>
              <th>Adapters</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <Fragment key={device.id}>
                <tr>
                  <td>
                    <button
                      className="btn btn-secondary"
                      onClick={() => handleExpand(device.id)}
                      style={{
                        textDecoration: 'none',
                        fontWeight: expandedDeviceId === device.id ? 600 : 400,
                      }}
                    >
                      {expandedDeviceId === device.id ? '\u25BC' : '\u25B6'}{' '}
                      {device.name}
                    </button>
                  </td>
                  <td>
                    <span className="badge">
                      {formatRelativeTime(device.lastSeen)}
                    </span>
                  </td>
                  <td>
                    <DeviceAdapterSummary device={device} vaultKey={vaultKey} />
                  </td>
                  <td>
                    <button
                      className="btn btn-secondary"
                      onClick={() => handleRemoveDevice(device.id, device.name)}
                      style={{ color: '#ff6b6b' }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
                {expandedDeviceId === device.id && (
                  <tr>
                    <td colSpan={4}>
                      <div className="panel-section">
                        {settingsLoading && <div>Decrypting settings...</div>}
                        {settingsError && (
                          <div style={{ color: '#ff6b6b', marginBottom: '0.5rem' }}>
                            {settingsError}
                          </div>
                        )}
                        {editSettings && !settingsLoading && (
                          <>
                            <div style={{ marginBottom: '1rem' }}>
                              <strong>Adapters & Sync Direction</strong>
                              <div style={{ marginTop: '0.5rem' }}>
                                {ADAPTER_NAMES.map(({ key, label }) => (
                                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                                    <span style={{ minWidth: '6rem' }}>{label}</span>
                                    <select
                                      className="form-input"
                                      style={{ width: 'auto', flex: 'none' }}
                                      value={editSettings.adapters[key].enabled ? editSettings.adapters[key].syncDirection : 'off'}
                                      onChange={(e) => handleSyncDirectionChange(key, e.target.value as SyncDirection)}
                                    >
                                      <option value="off">Off</option>
                                      <option value="receive-only">Receive only</option>
                                      <option value="send-receive">Send & Receive</option>
                                    </select>
                                  </div>
                                ))}
                              </div>
                            </div>

                            <div style={{ marginBottom: '1rem' }}>
                              <strong>Scan Paths</strong>
                              <div className="scan-path-list">
                                {editSettings.scanPaths.length === 0 && (
                                  <div
                                    className="scan-path-item"
                                    style={{ opacity: 0.6 }}
                                  >
                                    No scan paths configured
                                  </div>
                                )}
                                {editSettings.scanPaths.map((p, i) => (
                                  <div key={i} className="scan-path-item">
                                    <code>{p}</code>
                                    <button
                                      className="btn btn-secondary"
                                      onClick={() => handleRemovePath(i)}
                                      style={{
                                        color: '#ff6b6b',
                                        marginLeft: '0.5rem',
                                        padding: '0 0.4rem',
                                      }}
                                    >
                                      X
                                    </button>
                                  </div>
                                ))}
                              </div>
                              <div className="form-row">
                                <input
                                  className="form-input"
                                  type="text"
                                  placeholder="/path/to/directory"
                                  value={newPath}
                                  onChange={(e) => setNewPath(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleAddPath();
                                  }}
                                />
                                <button
                                  className="btn btn-secondary"
                                  onClick={handleAddPath}
                                  disabled={!newPath.trim()}
                                >
                                  Add
                                </button>
                              </div>
                            </div>

                            <button
                              className="btn btn-primary"
                              onClick={() => handleSave(device.id)}
                              disabled={saving}
                            >
                              {saving ? 'Saving...' : 'Save Settings'}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DeviceAdapterSummary({ device, vaultKey }: { device: Device; vaultKey: CryptoKey | null }) {
  const [settings, setSettings] = useState<DeviceSettings | null>(null);

  useEffect(() => {
    if (!device.encryptedSettings || !vaultKey) return;
    decryptSettings(device.encryptedSettings, vaultKey)
      .then(setSettings)
      .catch(() => setSettings(null));
  }, [device.encryptedSettings, vaultKey]);

  if (!settings) {
    return <span style={{ opacity: 0.5 }}>--</span>;
  }

  const active = ADAPTER_NAMES.filter(({ key }) => settings.adapters[key].enabled);
  if (active.length === 0) {
    return <span style={{ opacity: 0.5 }}>none</span>;
  }

  return (
    <span style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
      {active.map(({ key, label }) => (
        <span
          key={key}
          className={syncDirectionBadgeClass(settings.adapters[key].syncDirection)}
          title={`${label}: ${syncDirectionLabel(settings.adapters[key].syncDirection)}`}
        >
          {label.split(' ')[0]}
        </span>
      ))}
    </span>
  );
}
