import { contextBridge, ipcRenderer } from 'electron';

import type {
  AppSettings,
  AppSettingsInput,
  ProcessingItem,
  WorkerEvent,
  WorkerLifecycleEvent
} from '@videotitler/core';

type Unsubscribe = () => void;

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  if (payload === undefined) {
    return ipcRenderer.invoke(channel) as Promise<T>;
  }

  return ipcRenderer.invoke(channel, payload) as Promise<T>;
}

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  loadSettings: (): Promise<AppSettings> => invoke('app:load-settings'),
  saveSettings: (settings: AppSettingsInput): Promise<AppSettings> => invoke('app:save-settings', settings),
  selectDirectory: (defaultPath?: string): Promise<string | null> =>
    invoke('dialog:select-directory', defaultPath ? { defaultPath } : undefined),
  openDirectory: (targetPath: string): Promise<void> => invoke('shell:open-directory', targetPath),
  scanVideos: (args: { directory: string; includeSubdirs: boolean }): Promise<ProcessingItem[]> =>
    invoke('worker:scan-videos', args),
  startProcessing: (settings: AppSettingsInput): Promise<void> => invoke('worker:start-processing', settings),
  stopProcessing: (): Promise<void> => invoke('worker:stop-processing'),
  saveOcrEdit: (id: string, text: string): Promise<ProcessingItem> => invoke('worker:save-ocr-edit', { id, text }),
  saveTitleEdit: (id: string, title: string): Promise<ProcessingItem> => invoke('worker:save-title-edit', { id, title }),
  generateTitle: (id: string, ocrText?: string): Promise<ProcessingItem> =>
    invoke('worker:generate-title', { id, ocrText }),
  renameOne: (id: string, suggestedTitle?: string): Promise<ProcessingItem> =>
    invoke('worker:rename-one', { id, suggestedTitle }),
  renameAll: (settings: AppSettingsInput): Promise<void> => invoke('worker:rename-all', settings),
  onWorkerEvent: (callback: (event: WorkerEvent) => void): Unsubscribe => subscribe('worker:event', callback),
  onWorkerLifecycle: (callback: (event: WorkerLifecycleEvent) => void): Unsubscribe =>
    subscribe('worker:lifecycle', callback)
};

contextBridge.exposeInMainWorld('videoTitlerApi', api);

export type VideoTitlerApi = typeof api;
