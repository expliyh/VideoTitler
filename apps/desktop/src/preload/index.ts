import { contextBridge, ipcRenderer } from 'electron';
import type { VideoRecord } from '@videotitler/core';

export type ScanResponse = { videos: VideoRecord[]; logs: string[] };

const api = {
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:select-directory'),
  scanVideos: (directory: string, frameNumber: number): Promise<ScanResponse> =>
    ipcRenderer.invoke('videos:scan', { directory, frameNumber }),
  updateFrameNumber: (ids: string[], frameNumber: number): Promise<ScanResponse> =>
    ipcRenderer.invoke('videos:update-frame', { ids, frameNumber }),
  generateTitle: (id: string, ocrText?: string): Promise<{ video: VideoRecord | null; logs: string[] }> =>
    ipcRenderer.invoke('videos:generate-title', { id, ocrText }),
  renameOne: (id: string, index: number): Promise<{ video: VideoRecord | null; logs: string[] }> =>
    ipcRenderer.invoke('videos:rename-one', { id, index }),
  renameAll: (ids: string[]): Promise<{ videos: VideoRecord[]; logs: string[] }> =>
    ipcRenderer.invoke('videos:rename-all', { ids })
};

contextBridge.exposeInMainWorld('videoTitlerApi', api);

export type VideoTitlerApi = typeof api;
