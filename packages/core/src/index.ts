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
