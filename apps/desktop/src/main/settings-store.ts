import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AppSecretsState, AppSettingsInput } from '@videotitler/core';

export type SecretValues = {
  baiduApiKey: string;
  baiduSecretKey: string;
  deepseekApiKey: string;
};

type SecretInput = Pick<
  AppSettingsInput,
  | 'baiduApiKey'
  | 'baiduSecretKey'
  | 'deepseekApiKey'
  | 'clearBaiduApiKey'
  | 'clearBaiduSecretKey'
  | 'clearDeepseekApiKey'
>;

export type SecretCrypto = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

type SecretFilePayload = {
  version: 1;
  values: Record<keyof SecretValues, string>;
};

const EMPTY_SECRETS: SecretValues = {
  baiduApiKey: '',
  baiduSecretKey: '',
  deepseekApiKey: ''
};

const SECRET_KEYS: Array<keyof SecretValues> = ['baiduApiKey', 'baiduSecretKey', 'deepseekApiKey'];

const SECRET_CLEAR_FLAGS: Record<keyof SecretValues, keyof SecretInput> = {
  baiduApiKey: 'clearBaiduApiKey',
  baiduSecretKey: 'clearBaiduSecretKey',
  deepseekApiKey: 'clearDeepseekApiKey'
};

export function applySecretUpdates(existing: SecretValues, input: SecretInput): SecretValues {
  const nextValues: SecretValues = { ...existing };

  for (const key of SECRET_KEYS) {
    if (input[SECRET_CLEAR_FLAGS[key]]) {
      nextValues[key] = '';
      continue;
    }

    const rawValue = input[key];
    if (typeof rawValue !== 'string') {
      continue;
    }

    const trimmed = rawValue.trim();
    if (trimmed) {
      nextValues[key] = trimmed;
    }
  }

  return nextValues;
}

export function getSecretPresence(values: SecretValues): AppSecretsState {
  return {
    hasBaiduApiKey: Boolean(values.baiduApiKey),
    hasBaiduSecretKey: Boolean(values.baiduSecretKey),
    hasDeepseekApiKey: Boolean(values.deepseekApiKey)
  };
}

export class EncryptedSecretFileStore {
  private readonly filePath: string;
  private readonly crypto: SecretCrypto;

  constructor(filePath: string, crypto: SecretCrypto) {
    this.filePath = filePath;
    this.crypto = crypto;
  }

  async read(): Promise<SecretValues> {
    try {
      const rawText = await readFile(this.filePath, 'utf8');
      const payload = JSON.parse(rawText) as Partial<SecretFilePayload>;
      const encryptedValues: Partial<Record<keyof SecretValues, string>> = payload.values ?? {};

      const values: SecretValues = { ...EMPTY_SECRETS };
      for (const key of SECRET_KEYS) {
        const encrypted = encryptedValues[key];
        if (typeof encrypted !== 'string' || !encrypted) {
          values[key] = '';
          continue;
        }

        const decrypted = this.crypto.decryptString(Buffer.from(encrypted, 'base64'));
        values[key] = decrypted.trim();
      }

      return values;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code === 'ENOENT') {
        return { ...EMPTY_SECRETS };
      }
      throw error;
    }
  }

  async write(values: SecretValues): Promise<void> {
    if (!this.crypto.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable on this system.');
    }

    const payload: SecretFilePayload = {
      version: 1,
      values: {
        baiduApiKey: this.crypto.encryptString(values.baiduApiKey).toString('base64'),
        baiduSecretKey: this.crypto.encryptString(values.baiduSecretKey).toString('base64'),
        deepseekApiKey: this.crypto.encryptString(values.deepseekApiKey).toString('base64')
      }
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}

export function createEmptySecrets(): SecretValues {
  return { ...EMPTY_SECRETS };
}
