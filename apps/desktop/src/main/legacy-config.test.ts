import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EncryptedSecretFileStore } from './settings-store.ts';
import { migrateLegacyConfigIfNeeded } from './legacy-config.ts';

function createSecretStore(filePath: string) {
  return new EncryptedSecretFileStore(filePath, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value.split('').reverse().join(''), 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8').split('').reverse().join('')
  });
}

test('migrateLegacyConfigIfNeeded copies legacy settings and secrets when no new settings exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'videotitler-legacy-'));
  const settingsPath = join(dir, 'user-data', 'settings.json');
  const secretsPath = join(dir, 'user-data', 'secrets.json');
  const legacyPath = join(dir, 'config.json');
  const secretStore = createSecretStore(secretsPath);

  await writeFile(
    legacyPath,
    JSON.stringify(
      {
        input_dir: 'C:/videos',
        include_subdirs: true,
        frame_number_1based: 9,
        start_index: 3,
        index_padding: 4,
        dry_run: true,
        baidu_api_key: 'legacy-baidu-key',
        baidu_secret_key: 'legacy-baidu-secret',
        baidu_ocr_mode: 'general_basic',
        deepseek_api_key: 'legacy-deepseek-key',
        deepseek_base_url: 'https://api.deepseek.com/v1',
        deepseek_model: 'deepseek-chat',
        deepseek_system_prompt: 'system prompt',
        deepseek_user_prompt_template: 'user {ocr_text}',
        save_keys_locally: true,
        recent_dirs: ['C:/videos']
      },
      null,
      2
    ),
    'utf8'
  );

  const migrated = await migrateLegacyConfigIfNeeded({
    settingsPath,
    legacyConfigPath: legacyPath,
    secretStore
  });

  assert.equal(migrated, true);

  const rawSettings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  assert.equal(rawSettings.input_dir, 'C:/videos');
  assert.equal(rawSettings.include_subdirs, true);
  assert.equal(rawSettings.baidu_api_key, undefined);
  assert.equal(rawSettings.deepseek_api_key, undefined);

  assert.deepEqual(await secretStore.read(), {
    baiduApiKey: 'legacy-baidu-key',
    baiduSecretKey: 'legacy-baidu-secret',
    deepseekApiKey: 'legacy-deepseek-key'
  });
});

test('migrateLegacyConfigIfNeeded does not overwrite existing new settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'videotitler-legacy-'));
  const settingsPath = join(dir, 'user-data', 'settings.json');
  const secretsPath = join(dir, 'user-data', 'secrets.json');
  const legacyPath = join(dir, 'config.json');
  const secretStore = createSecretStore(secretsPath);

  await mkdir(join(dir, 'user-data'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ input_dir: 'C:/new-config' }, null, 2), 'utf8');
  await writeFile(
    legacyPath,
    JSON.stringify(
      {
        input_dir: 'C:/legacy-config',
        baidu_api_key: 'legacy-baidu-key',
        baidu_secret_key: 'legacy-baidu-secret',
        deepseek_api_key: 'legacy-deepseek-key'
      },
      null,
      2
    ),
    'utf8'
  );
  await secretStore.write({
    baiduApiKey: 'secure-existing',
    baiduSecretKey: '',
    deepseekApiKey: ''
  });

  const migrated = await migrateLegacyConfigIfNeeded({
    settingsPath,
    legacyConfigPath: legacyPath,
    secretStore
  });

  assert.equal(migrated, false);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { input_dir: 'C:/new-config' });
  assert.deepEqual(await secretStore.read(), {
    baiduApiKey: 'secure-existing',
    baiduSecretKey: '',
    deepseekApiKey: ''
  });
});
