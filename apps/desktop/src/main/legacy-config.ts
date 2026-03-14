import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { SecretValues } from './settings-store';

type SecretStoreLike = {
  read(): Promise<SecretValues>;
  write(values: SecretValues): Promise<void>;
};

type LegacyMigrationOptions = {
  settingsPath: string;
  legacyConfigPath: string;
  secretStore: SecretStoreLike;
};

const NON_SECRET_FIELDS = [
  'input_dir',
  'include_subdirs',
  'frame_number_1based',
  'start_index',
  'index_padding',
  'dry_run',
  'baidu_ocr_mode',
  'deepseek_base_url',
  'deepseek_model',
  'deepseek_system_prompt',
  'deepseek_user_prompt_template',
  'ui_language',
  'recent_dirs'
] as const;

type LegacyConfig = Partial<Record<(typeof NON_SECRET_FIELDS)[number], unknown>> & {
  baidu_api_key?: unknown;
  baidu_secret_key?: unknown;
  deepseek_api_key?: unknown;
};

function normalizeSecret(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function migrateLegacyConfigIfNeeded(options: LegacyMigrationOptions): Promise<boolean> {
  if (existsSync(options.settingsPath) || !existsSync(options.legacyConfigPath)) {
    return false;
  }

  const rawConfig = await readFile(options.legacyConfigPath, 'utf8');
  const legacyConfig = JSON.parse(rawConfig) as LegacyConfig;

  const settingsPayload: Record<string, unknown> = {};
  for (const field of NON_SECRET_FIELDS) {
    if (field in legacyConfig) {
      settingsPayload[field] = legacyConfig[field];
    }
  }

  await mkdir(dirname(options.settingsPath), { recursive: true });
  await writeFile(options.settingsPath, JSON.stringify(settingsPayload, null, 2), 'utf8');

  const currentSecrets = await options.secretStore.read();
  const nextSecrets: SecretValues = {
    baiduApiKey: currentSecrets.baiduApiKey || normalizeSecret(legacyConfig.baidu_api_key),
    baiduSecretKey: currentSecrets.baiduSecretKey || normalizeSecret(legacyConfig.baidu_secret_key),
    deepseekApiKey: currentSecrets.deepseekApiKey || normalizeSecret(legacyConfig.deepseek_api_key)
  };

  if (
    nextSecrets.baiduApiKey !== currentSecrets.baiduApiKey ||
    nextSecrets.baiduSecretKey !== currentSecrets.baiduSecretKey ||
    nextSecrets.deepseekApiKey !== currentSecrets.deepseekApiKey
  ) {
    await options.secretStore.write(nextSecrets);
  }

  return true;
}
