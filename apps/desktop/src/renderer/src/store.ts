import { create } from 'zustand';
import type { VideoRecord } from '@videotitler/core';

type AppState = {
  directory: string;
  frameNumber: number;
  videos: VideoRecord[];
  logs: string[];
  setDirectory: (directory: string) => void;
  setFrameNumber: (frameNumber: number) => void;
  setVideos: (videos: VideoRecord[]) => void;
  mergeVideo: (video: VideoRecord) => void;
  appendLogs: (logs: string[]) => void;
};

export const useAppStore = create<AppState>((set) => ({
  directory: '',
  frameNumber: 1,
  videos: [],
  logs: [],
  setDirectory: (directory) => set({ directory }),
  setFrameNumber: (frameNumber) => set({ frameNumber }),
  setVideos: (videos) => set({ videos }),
  mergeVideo: (video) =>
    set((state) => ({
      videos: state.videos.map((item) => (item.id === video.id ? video : item))
    })),
  appendLogs: (logs) => set((state) => ({ logs: [...state.logs, ...logs] }))
}));
