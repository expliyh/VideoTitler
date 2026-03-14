import type { VideoTitlerApi } from './index';

declare global {
  interface Window {
    videoTitlerApi: VideoTitlerApi;
  }
}

export {};
