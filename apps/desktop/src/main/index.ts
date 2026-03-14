import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { join, extname, dirname, basename } from 'node:path';
import { readdir, rename } from 'node:fs/promises';
import {
  buildRenameTarget,
  createVideoRecord,
  extractTitleFromOcr,
  isVideoFile,
  pickNonConflictingPath,
  type RenameRequestItem,
  type VideoRecord
} from '@videotitler/core';
import { resolvePreloadPath } from './preload-path';

let mainWindow: BrowserWindow | null = null;
const memoryStore = new Map<string, VideoRecord>();

function pushLog(message: string): string {
  return `[${new Date().toLocaleTimeString()}] ${message}`;
}

function formatDebugPayload(payload?: unknown): string {
  if (payload === undefined) return '';
  try {
    return ` ${JSON.stringify(payload)}`;
  } catch {
    return ` ${String(payload)}`;
  }
}

function debugLog(scope: string, message: string, payload?: unknown): void {
  const line = `[debug:${scope}] ${message}${formatDebugPayload(payload)}`;
  console.info(line);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('debug:log', pushLog(line));
  }
}

async function createWindow() {
  const preloadPath = resolvePreloadPath(__dirname);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  debugLog('main', 'created BrowserWindow', {
    preloadPath,
    rendererUrl: process.env.ELECTRON_RENDERER_URL ?? null
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  debugLog('main', 'window content loaded');
}

app.whenReady().then(() => {
  ipcMain.handle('dialog:select-directory', async () => {
    debugLog('main', 'received dialog:select-directory');
    try {
      const options: OpenDialogOptions = { properties: ['openDirectory'] };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      debugLog('main', 'showOpenDialog resolved', {
        canceled: result.canceled,
        filePaths: result.filePaths
      });
      return result.canceled ? null : result.filePaths[0];
    } catch (error) {
      debugLog('main', 'showOpenDialog failed', {
        error: error instanceof Error ? error.stack ?? error.message : String(error)
      });
      throw error;
    }
  });

  ipcMain.handle('videos:scan', async (_event, args: { directory: string; frameNumber: number }) => {
    const entries = await readdir(args.directory, { withFileTypes: true });
    const scanned = entries
      .filter((entry) => entry.isFile() && isVideoFile(entry.name))
      .map((entry) => createVideoRecord(join(args.directory, entry.name), args.frameNumber));

    memoryStore.clear();
    scanned.forEach((item) => memoryStore.set(item.id, item));

    return {
      videos: scanned,
      logs: [pushLog(`扫描完成，共发现 ${scanned.length} 条视频`)]
    };
  });

  ipcMain.handle('videos:update-frame', async (_event, args: { ids: string[]; frameNumber: number }) => {
    const updated: VideoRecord[] = [];
    args.ids.forEach((id) => {
      const item = memoryStore.get(id);
      if (!item) return;
      item.frameNumber = args.frameNumber;
      updated.push(item);
    });

    return {
      videos: updated,
      logs: [pushLog(`已更新 ${updated.length} 条记录的帧号为 ${args.frameNumber}`)]
    };
  });

  ipcMain.handle('videos:generate-title', async (_event, args: { id: string; ocrText?: string }) => {
    const item = memoryStore.get(args.id);
    if (!item) {
      return { video: null, logs: [pushLog('目标记录不存在')] };
    }

    if (typeof args.ocrText === 'string') {
      item.ocrText = args.ocrText;
    }

    item.suggestedTitle = extractTitleFromOcr(item.ocrText);
    item.status = 'ready';

    return {
      video: item,
      logs: [pushLog(`已生成标题：${item.suggestedTitle}`)]
    };
  });

  ipcMain.handle('videos:rename-one', async (_event, args: { id: string; index: number; suggestedTitle: string }) => {
    const item = memoryStore.get(args.id);
    if (!item) {
      return { video: null, logs: [pushLog('目标记录不存在')] };
    }

    item.suggestedTitle = args.suggestedTitle;
    const extension = extname(item.fileName);
    const nextName = buildRenameTarget({
      index: args.index,
      title: item.suggestedTitle,
      extension
    });

    const from = item.fullPath;
    const to = await pickNonConflictingPath(join(dirname(item.fullPath), nextName), from);

    if (to !== from) {
      await rename(from, to);
    }
    item.fileName = basename(to);
    item.fullPath = to;
    item.status = 'renamed';
    item.message = undefined;

    return {
      video: item,
      logs: [pushLog(`重命名成功：${item.fileName}`)]
    };
  });

  ipcMain.handle('videos:rename-all', async (_event, args: { items: RenameRequestItem[] }) => {
    const updated: VideoRecord[] = [];
    const logs: string[] = [];

    for (let i = 0; i < args.items.length; i += 1) {
      const requestItem = args.items[i];
      const item = memoryStore.get(requestItem.id);
      if (!item) continue;

      try {
        item.suggestedTitle = requestItem.suggestedTitle;
        const nextName = buildRenameTarget({
          index: i + 1,
          title: item.suggestedTitle,
          extension: extname(item.fileName)
        });
        const from = item.fullPath;
        const to = await pickNonConflictingPath(join(dirname(item.fullPath), nextName), from);
        if (to !== from) {
          await rename(from, to);
        }
        item.fileName = basename(to);
        item.fullPath = to;
        item.status = 'renamed';
        item.message = undefined;
        updated.push(item);
        logs.push(pushLog(`批量重命名成功：${item.fileName}`));
      } catch (error) {
        item.status = 'error';
        item.message = String(error);
        logs.push(pushLog(`批量重命名失败：${item.fileName}`));
      }
    }

    return {
      videos: updated,
      logs
    };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
