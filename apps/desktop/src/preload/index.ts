import { contextBridge, ipcRenderer } from 'electron';
import type { RenameRequestItem, VideoRecord } from '@videotitler/core';

export type ScanResponse = { videos: VideoRecord[]; logs: string[] };

function logPreload(message: string, payload?: unknown): void {
  if (payload === undefined) {
    console.info(`[preload] ${message}`);
    return;
  }
  console.info(`[preload] ${message}`, payload);
}

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  logPreload(`invoke ${channel}`, payload);
  try {
    const result = payload === undefined
      ? await ipcRenderer.invoke(channel)
      : await ipcRenderer.invoke(channel, payload);
    logPreload(`invoke ${channel} resolved`, result);
    return result as T;
  } catch (error) {
    console.error(`[preload] invoke ${channel} failed`, error);
    throw error;
  }
}

const api = {
  selectDirectory: (): Promise<string | null> => invoke('dialog:select-directory'),
  scanVideos: (directory: string, frameNumber: number): Promise<ScanResponse> =>
    invoke('videos:scan', { directory, frameNumber }),
  updateFrameNumber: (ids: string[], frameNumber: number): Promise<ScanResponse> =>
    invoke('videos:update-frame', { ids, frameNumber }),
  generateTitle: (id: string, ocrText?: string): Promise<{ video: VideoRecord | null; logs: string[] }> =>
    invoke('videos:generate-title', { id, ocrText }),
  renameOne: (id: string, index: number, suggestedTitle: string): Promise<{ video: VideoRecord | null; logs: string[] }> =>
    invoke('videos:rename-one', { id, index, suggestedTitle }),
  renameAll: (items: RenameRequestItem[]): Promise<{ videos: VideoRecord[]; logs: string[] }> =>
    invoke('videos:rename-all', { items }),
  onDebugLog: (callback: (message: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('debug:log', listener);
    return () => ipcRenderer.removeListener('debug:log', listener);
  }
};

contextBridge.exposeInMainWorld('videoTitlerApi', api);

export type VideoTitlerApi = typeof api;
