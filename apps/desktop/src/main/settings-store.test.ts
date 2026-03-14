import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EncryptedSecretFileStore,
  applySecretUpdates,
  getSecretPresence,
  type SecretValues
} from './settings-store.ts';

test('applySecretUpdates preserves stored secrets when blank inputs are submitted', () => {
  const existing: SecretValues = {
    baiduApiKey: 'baidu-key',
    baiduSecretKey: 'baidu-secret',
    deepseekApiKey: 'deepseek-key'
  };

  const updated = applySecretUpdates(existing, {
    baiduApiKey: '',
    baiduSecretKey: '',
    deepseekApiKey: ''
  });

  assert.deepEqual(updated, existing);
});

test('applySecretUpdates replaces and clears only the requested secrets', () => {
  const existing: SecretValues = {
    baiduApiKey: 'baidu-key',
    baiduSecretKey: 'baidu-secret',
    deepseekApiKey: 'deepseek-key'
  };

  const updated = applySecretUpdates(existing, {
    baiduApiKey: 'new-baidu-key',
    clearBaiduSecretKey: true,
    deepseekApiKey: ''
  });

  assert.deepEqual(updated, {
    baiduApiKey: 'new-baidu-key',
    baiduSecretKey: '',
    deepseekApiKey: 'deepseek-key'
  });
});

test('getSecretPresence reports whether encrypted secrets exist', () => {
  assert.deepEqual(
    getSecretPresence({
      baiduApiKey: 'baidu-key',
      baiduSecretKey: '',
      deepseekApiKey: 'deepseek-key'
    }),
    {
      hasBaiduApiKey: true,
      hasBaiduSecretKey: false,
      hasDeepseekApiKey: true
    }
  );
});

test('EncryptedSecretFileStore round-trips encrypted secrets without writing raw values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'videotitler-secrets-'));
  const filePath = join(dir, 'secrets.json');
  const store = new EncryptedSecretFileStore(filePath, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value.split('').reverse().join(''), 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8').split('').reverse().join('')
  });

  const values: SecretValues = {
    baiduApiKey: 'baidu-key',
    baiduSecretKey: 'baidu-secret',
    deepseekApiKey: 'deepseek-key'
  };

  await store.write(values);
  const rawText = readFileSync(filePath, 'utf8');

  assert.equal(rawText.includes('baidu-key'), false);
  assert.equal(rawText.includes('baidu-secret'), false);
  assert.equal(rawText.includes('deepseek-key'), false);
  assert.deepEqual(await store.read(), values);
});

test('EncryptedSecretFileStore returns empty secrets when the file does not exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'videotitler-secrets-'));
  const filePath = join(dir, 'missing.json');
  const store = new EncryptedSecretFileStore(filePath, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8')
  });

  assert.deepEqual(await store.read(), {
    baiduApiKey: '',
    baiduSecretKey: '',
    deepseekApiKey: ''
  });
});
