import { join } from 'node:path';

import type {
  AppSettings,
  AppSettingsInput,
  ProcessingItem,
  WorkerEvent,
  WorkerLifecycleEvent
} from '@videotitler/core';

import { resolveProjectRoot, resolvePythonExecutable } from './python-runtime';
import { PythonWorkerClient } from './python-worker';
import { migrateLegacyConfigIfNeeded } from './legacy-config';
import {
  EncryptedSecretFileStore,
  applySecretUpdates,
  createEmptySecrets,
  getSecretPresence,
  type SecretCrypto,
  type SecretValues
} from './settings-store';

type WorkerSettingsPayload = Omit<AppSettings, 'secretsState'>;

type BackendOptions = {
  mainDir: string;
  cwd: string;
  userDataPath: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  secretCrypto: SecretCrypto;
  onWorkerEvent(event: WorkerEvent): void;
  onLifecycle(event: WorkerLifecycleEvent): void;
};

function toWorkerSettingsPayload(settings: AppSettingsInput): WorkerSettingsPayload {
  return {
    inputDir: settings.inputDir,
    includeSubdirs: settings.includeSubdirs,
    frameNumber: settings.frameNumber,
    startIndex: settings.startIndex,
    indexPadding: settings.indexPadding,
    dryRun: settings.dryRun,
    ocrMode: settings.ocrMode,
    deepseekBaseUrl: settings.deepseekBaseUrl,
    deepseekModel: settings.deepseekModel,
    deepseekSystemPrompt: settings.deepseekSystemPrompt,
    deepseekUserPromptTemplate: settings.deepseekUserPromptTemplate,
    recentDirs: settings.recentDirs
  };
}

export class DesktopBackend {
  private readonly options: BackendOptions;
  private readonly settingsPath: string;
  private readonly secretStore: EncryptedSecretFileStore;
  private worker: PythonWorkerClient | null;

  constructor(options: BackendOptions) {
    this.options = options;
    this.settingsPath = join(options.userDataPath, 'settings.json');
    this.secretStore = new EncryptedSecretFileStore(
      join(options.userDataPath, 'secrets.json'),
      options.secretCrypto
    );
    this.worker = null;
  }

  async start(): Promise<void> {
    await this.ensureWorker();
  }

  async shutdown(): Promise<void> {
    if (!this.worker) {
      return;
    }

    const worker = this.worker;
    this.worker = null;
    await worker.shutdown();
  }

  async loadSettings(): Promise<AppSettings> {
    const worker = await this.ensureWorker();
    const payload = await worker.request<{ settings: WorkerSettingsPayload }>('load_settings', {});
    const secrets = await this.readSecrets();
    return {
      ...payload.settings,
      secretsState: getSecretPresence(secrets)
    };
  }

  async saveSettings(settings: AppSettingsInput): Promise<AppSettings> {
    const worker = await this.ensureWorker();
    const secrets = await this.readSecrets();
    const updatedSecrets = applySecretUpdates(secrets, settings);
    await this.secretStore.write(updatedSecrets);

    const payload = await worker.request<{ settings: WorkerSettingsPayload }>('save_settings', {
      settings: toWorkerSettingsPayload(settings)
    });

    return {
      ...payload.settings,
      secretsState: getSecretPresence(updatedSecrets)
    };
  }

  async scanVideos(args: { directory: string; includeSubdirs: boolean }): Promise<ProcessingItem[]> {
    const worker = await this.ensureWorker();
    const payload = await worker.request<{ items: ProcessingItem[] }>('scan_videos', args);
    this.options.onWorkerEvent({
      event: 'scan_result',
      items: payload.items
    });
    return payload.items;
  }

  async startProcessing(settings: AppSettingsInput): Promise<void> {
    const worker = await this.ensureWorker();
    const secrets = await this.readSecrets();
    await worker.request('start_processing', {
      settings: toWorkerSettingsPayload(settings),
      secrets
    });
  }

  async stopProcessing(): Promise<void> {
    const worker = await this.ensureWorker();
    await worker.request('stop_processing', {});
  }

  async saveOcrEdit(id: string, text: string): Promise<ProcessingItem> {
    const worker = await this.ensureWorker();
    const payload = await worker.request<{ item: ProcessingItem }>('save_ocr_edit', { id, text });
    return payload.item;
  }

  async saveTitleEdit(id: string, title: string): Promise<ProcessingItem> {
    const worker = await this.ensureWorker();
    const payload = await worker.request<{ item: ProcessingItem }>('save_title_edit', { id, title });
    return payload.item;
  }

  async generateTitle(id: string, ocrText?: string): Promise<ProcessingItem> {
    const worker = await this.ensureWorker();
    const secrets = await this.readSecrets();
    const payload = await worker.request<{ item: ProcessingItem }>('generate_title_from_ocr', {
      id,
      ocrText,
      secrets
    });
    return payload.item;
  }

  async renameOne(id: string, suggestedTitle?: string): Promise<ProcessingItem> {
    const worker = await this.ensureWorker();
    const payload = await worker.request<{ item: ProcessingItem }>('rename_one', {
      id,
      suggestedTitle
    });
    return payload.item;
  }

  async renameAll(settings: AppSettingsInput): Promise<void> {
    const worker = await this.ensureWorker();
    await worker.request('rename_all', {
      settings: toWorkerSettingsPayload(settings)
    });
  }

  private async ensureWorker(): Promise<PythonWorkerClient> {
    if (this.worker) {
      return this.worker;
    }

    this.options.onLifecycle({
      state: 'starting',
      message: 'Starting Python worker...'
    });

    const projectRoot = resolveProjectRoot({
      cwd: this.options.cwd,
      mainDir: this.options.mainDir
    });
    await this.migrateLegacyConfig(projectRoot);
    const pythonExecutable = resolvePythonExecutable({
      projectRoot,
      env: this.options.env,
      platform: this.options.platform
    });

    const worker = new PythonWorkerClient({
      command: pythonExecutable,
      args: ['-m', 'videotitler.worker'],
      cwd: projectRoot,
      env: {
        ...this.options.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        VIDEOTITLER_SETTINGS_PATH: this.settingsPath
      }
    });

    worker.on('event', (payload) => {
      const event = payload as WorkerEvent & { type?: string };
      const { type: _type, ...workerEvent } = event;
      this.options.onWorkerEvent(workerEvent as WorkerEvent);
    });

    worker.on('stderr', (line) => {
      this.options.onWorkerEvent({
        event: 'log',
        message: `[worker:stderr] ${String(line)}`
      });
    });

    worker.on('exit', ({ code }) => {
      this.worker = null;
      this.options.onLifecycle({
        state: code === 0 ? 'stopped' : 'error',
        message: code === 0 ? 'Python worker stopped.' : `Python worker exited with code ${code ?? 'null'}.`
      });
    });

    worker.on('error', (error) => {
      this.options.onLifecycle({
        state: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
    });

    await worker.start();
    this.worker = worker;
    this.options.onLifecycle({
      state: 'ready',
      message: `Python worker ready (${pythonExecutable}).`
    });
    return worker;
  }

  private async readSecrets(): Promise<SecretValues> {
    try {
      return await this.secretStore.read();
    } catch (error) {
      this.options.onWorkerEvent({
        event: 'log',
        message: `[main] Failed to read secure secrets: ${error instanceof Error ? error.message : String(error)}`
      });
      return createEmptySecrets();
    }
  }

  private async migrateLegacyConfig(projectRoot: string): Promise<void> {
    try {
      const migrated = await migrateLegacyConfigIfNeeded({
        settingsPath: this.settingsPath,
        legacyConfigPath: join(projectRoot, 'config.json'),
        secretStore: this.secretStore
      });

      if (migrated) {
        this.options.onWorkerEvent({
          event: 'log',
          message: '[main] Imported legacy config.json into the new Electron settings store.'
        });
      }
    } catch (error) {
      this.options.onWorkerEvent({
        event: 'log',
        message: `[main] Failed to import legacy config.json: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
}
