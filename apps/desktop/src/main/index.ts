import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join, extname, dirname } from 'node:path';
import { readdir, rename } from 'node:fs/promises';
import {
  buildRenameTarget,
  createVideoRecord,
  extractTitleFromOcr,
  isVideoFile,
  type VideoRecord
} from '@videotitler/core';

let mainWindow: BrowserWindow | null = null;
const memoryStore = new Map<string, VideoRecord>();

function pushLog(message: string): string {
  return `[${new Date().toLocaleTimeString()}] ${message}`;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  ipcMain.handle('dialog:select-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
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

  ipcMain.handle('videos:rename-one', async (_event, args: { id: string; index: number }) => {
    const item = memoryStore.get(args.id);
    if (!item) {
      return { video: null, logs: [pushLog('目标记录不存在')] };
    }

    const extension = extname(item.fileName);
    const nextName = buildRenameTarget({
      index: args.index,
      title: item.suggestedTitle,
      extension
    });

    const from = item.fullPath;
    const to = join(dirname(item.fullPath), nextName);

    await rename(from, to);
    item.fileName = nextName;
    item.fullPath = to;
    item.status = 'renamed';

    return {
      video: item,
      logs: [pushLog(`重命名成功：${nextName}`)]
    };
  });

  ipcMain.handle('videos:rename-all', async (_event, args: { ids: string[] }) => {
    const updated: VideoRecord[] = [];
    const logs: string[] = [];

    for (let i = 0; i < args.ids.length; i += 1) {
      const id = args.ids[i];
      const item = memoryStore.get(id);
      if (!item) continue;

      try {
        const nextName = buildRenameTarget({
          index: i + 1,
          title: item.suggestedTitle,
          extension: extname(item.fileName)
        });
        const to = join(dirname(item.fullPath), nextName);
        await rename(item.fullPath, to);
        item.fileName = nextName;
        item.fullPath = to;
        item.status = 'renamed';
        updated.push(item);
        logs.push(pushLog(`批量重命名成功：${nextName}`));
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
