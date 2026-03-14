import { access } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export type VideoRecord = {
  id: string;
  fileName: string;
  fullPath: string;
  frameNumber: number;
  ocrText: string;
  suggestedTitle: string;
  status: 'idle' | 'ready' | 'renamed' | 'error';
  message?: string;
};

export type RenameRuleContext = {
  index: number;
  title: string;
  extension: string;
};

export type RenameRequestItem = {
  id: string;
  suggestedTitle: string;
};

export type OcrMode = 'accurate_basic' | 'general_basic';

export type AppSecretsState = {
  hasBaiduApiKey: boolean;
  hasBaiduSecretKey: boolean;
  hasDeepseekApiKey: boolean;
};

export type AppSettings = {
  inputDir: string;
  includeSubdirs: boolean;
  frameNumber: number;
  startIndex: number;
  indexPadding: number;
  dryRun: boolean;
  ocrMode: OcrMode;
  deepseekBaseUrl: string;
  deepseekModel: string;
  deepseekSystemPrompt: string;
  deepseekUserPromptTemplate: string;
  recentDirs: string[];
  secretsState: AppSecretsState;
};

export type AppSettingsInput = Omit<AppSettings, 'secretsState'> & {
  baiduApiKey?: string;
  baiduSecretKey?: string;
  deepseekApiKey?: string;
  clearBaiduApiKey?: boolean;
  clearBaiduSecretKey?: boolean;
  clearDeepseekApiKey?: boolean;
};

export type ProcessingItem = {
  id: string;
  fullPath: string;
  fileName: string;
  status: string;
  ocrText: string;
  suggestedTitle: string;
  newName: string;
  error: string;
  previewDataUrl: string;
};

export type ProcessingSessionState = {
  isProcessing: boolean;
  activeCommand: 'idle' | 'processing' | 'renaming';
  progressCurrent: number;
  progressTotal: number;
  lastDoneMessage: string;
};

export type WorkerLogEvent = {
  event: 'log';
  message: string;
};

export type WorkerScanResultEvent = {
  event: 'scan_result';
  items: ProcessingItem[];
};

export type WorkerItemPreviewEvent = {
  event: 'item_preview';
  id: string;
  previewDataUrl: string;
};

export type WorkerItemOcrEvent = {
  event: 'item_ocr';
  id: string;
  ocrText: string;
};

export type WorkerItemTitleEvent = {
  event: 'item_title';
  id: string;
  suggestedTitle: string;
  newName: string;
};

export type WorkerItemStatusEvent = {
  event: 'item_status';
  id: string;
  status: string;
  error: string;
};

export type WorkerItemRenamedEvent = {
  event: 'item_renamed';
  id: string;
  oldFullPath: string;
  oldFileName: string;
  fullPath: string;
  fileName: string;
  newName: string;
};

export type WorkerProgressEvent = {
  event: 'progress';
  current: number;
  total: number;
};

export type WorkerDoneEvent = {
  event: 'done';
  message: string;
};

export type WorkerErrorEvent = {
  event: 'error';
  id?: string;
  fileName?: string;
  fullPath?: string;
  message: string;
};

export type WorkerEvent =
  | WorkerLogEvent
  | WorkerScanResultEvent
  | WorkerItemPreviewEvent
  | WorkerItemOcrEvent
  | WorkerItemTitleEvent
  | WorkerItemStatusEvent
  | WorkerItemRenamedEvent
  | WorkerProgressEvent
  | WorkerDoneEvent
  | WorkerErrorEvent;

export type WorkerLifecycleEvent = {
  state: 'starting' | 'ready' | 'stopped' | 'error';
  message: string;
};

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']);

export function isVideoFile(fileName: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(fileName).toLowerCase());
}

export function buildRenameTarget(context: RenameRuleContext): string {
  const safeTitle = context.title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const paddedIndex = String(context.index).padStart(3, '0');
  return `${paddedIndex}-${safeTitle || '未命名'}${context.extension}`;
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

export async function pickNonConflictingPath(targetPath: string, ignorePath?: string): Promise<string> {
  if (ignorePath && targetPath === ignorePath) {
    return targetPath;
  }

  if (!(await pathExists(targetPath))) {
    return targetPath;
  }

  const extension = extname(targetPath);
  const stem = basename(targetPath, extension);
  const parent = dirname(targetPath);

  let counter = 2;
  while (true) {
    const candidate = join(parent, `${stem}_${counter}${extension}`);
    if ((!ignorePath || candidate !== ignorePath) && !(await pathExists(candidate))) {
      return candidate;
    }
    counter += 1;
  }
}

export function createVideoRecord(pathname: string, frameNumber: number): VideoRecord {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fileName: basename(pathname),
    fullPath: pathname,
    frameNumber,
    ocrText: '',
    suggestedTitle: '',
    status: 'idle'
  };
}

export function extractTitleFromOcr(ocrText: string): string {
  const oneLine = ocrText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');

  return oneLine.slice(0, 24) || '待补充标题';
}
