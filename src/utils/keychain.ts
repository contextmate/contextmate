import { execFile as execFileCb } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const SERVICE_NAME = 'contextmate';
const ACCOUNT_NAME = 'vault-passphrase';

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainError';
  }
}

export async function isKeychainAvailable(): Promise<boolean> {
  const platform = process.platform;
  if (platform === 'darwin') {
    try {
      await access('/usr/bin/security', constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  if (platform === 'linux') {
    try {
      await execFile('which', ['secret-tool']);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function storePassphrase(passphrase: string): Promise<void> {
  if (!(await isKeychainAvailable())) {
    throw new KeychainError('OS keychain is not available on this system.');
  }

  const platform = process.platform;
  if (platform === 'darwin') {
    try {
      await execFile('/usr/bin/security', [
        'add-generic-password',
        '-a', ACCOUNT_NAME,
        '-s', SERVICE_NAME,
        '-w', passphrase,
        '-U',
      ]);
    } catch (err) {
      throw new KeychainError(`Failed to store passphrase in Keychain: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (platform === 'linux') {
    try {
      const child = execFileCb('secret-tool', [
        'store',
        '--label=ContextMate Vault Passphrase',
        'service', SERVICE_NAME,
        'account', ACCOUNT_NAME,
      ]);
      child.stdin?.write(passphrase);
      child.stdin?.end();
      await new Promise<void>((resolve, reject) => {
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new KeychainError(`secret-tool store exited with code ${code}`));
        });
        child.on('error', reject);
      });
    } catch (err) {
      if (err instanceof KeychainError) throw err;
      throw new KeychainError(`Failed to store passphrase: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function retrievePassphrase(): Promise<string | null> {
  if (!(await isKeychainAvailable())) {
    return null;
  }

  const platform = process.platform;
  if (platform === 'darwin') {
    try {
      const { stdout } = await execFile('/usr/bin/security', [
        'find-generic-password',
        '-a', ACCOUNT_NAME,
        '-s', SERVICE_NAME,
        '-w',
      ]);
      return stdout.trim();
    } catch {
      return null;
    }
  } else if (platform === 'linux') {
    try {
      const { stdout } = await execFile('secret-tool', [
        'lookup',
        'service', SERVICE_NAME,
        'account', ACCOUNT_NAME,
      ]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function deletePassphrase(): Promise<void> {
  const platform = process.platform;
  if (platform === 'darwin') {
    try {
      await execFile('/usr/bin/security', [
        'delete-generic-password',
        '-a', ACCOUNT_NAME,
        '-s', SERVICE_NAME,
      ]);
    } catch {
      // Already removed or not stored
    }
  } else if (platform === 'linux') {
    try {
      await execFile('secret-tool', [
        'clear',
        'service', SERVICE_NAME,
        'account', ACCOUNT_NAME,
      ]);
    } catch {
      // Already removed or not stored
    }
  }
}
