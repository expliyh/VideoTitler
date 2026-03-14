import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  type OpenDialogOptions
} from 'electron';
import { join } from 'node:path';

import type { AppSettingsInput, WorkerEvent, WorkerLifecycleEvent } from '@videotitler/core';

import { DesktopBackend } from './backend';
import { resolvePreloadPath } from './preload-path';

let mainWindow: BrowserWindow | null = null;
let backend: DesktopBackend | null = null;

function sendToRenderer(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
}

function broadcastWorkerEvent(event: WorkerEvent): void {
  console.info('[worker:event]', event);
  sendToRenderer('worker:event', event);
}

function broadcastLifecycle(event: WorkerLifecycleEvent): void {
  console.info('[worker:lifecycle]', event);
  sendToRenderer('worker:lifecycle', event);
}

async function createWindow() {
  const preloadPath = resolvePreloadPath(__dirname);
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1180,
    minHeight: 780,
    webPreferences: {
      preload: preloadPath,
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

function getBackend(): DesktopBackend {
  if (!backend) {
    throw new Error('Desktop backend is not ready yet.');
  }
  return backend;
}

function registerIpcHandlers(): void {
  ipcMain.handle('app:load-settings', async () => getBackend().loadSettings());
  ipcMain.handle('app:save-settings', async (_event, settings: AppSettingsInput) => getBackend().saveSettings(settings));

  ipcMain.handle('dialog:select-directory', async (_event, args?: { defaultPath?: string }) => {
    const options: OpenDialogOptions = {
      properties: ['openDirectory']
    };

    if (args?.defaultPath?.trim()) {
      options.defaultPath = args.defaultPath.trim();
    }

    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('shell:open-directory', async (_event, targetPath: string) => {
    const openError = await shell.openPath(targetPath);
    if (openError) {
      throw new Error(openError);
    }
  });

  ipcMain.handle(
    'worker:scan-videos',
    async (_event, args: { directory: string; includeSubdirs: boolean }) => getBackend().scanVideos(args)
  );
  ipcMain.handle('worker:start-processing', async (_event, settings: AppSettingsInput) => getBackend().startProcessing(settings));
  ipcMain.handle('worker:stop-processing', async () => getBackend().stopProcessing());
  ipcMain.handle('worker:save-ocr-edit', async (_event, args: { id: string; text: string }) => getBackend().saveOcrEdit(args.id, args.text));
  ipcMain.handle('worker:save-title-edit', async (_event, args: { id: string; title: string }) => getBackend().saveTitleEdit(args.id, args.title));
  ipcMain.handle(
    'worker:rename-source-directory',
    async (_event, args: { directory: string; newName: string }) => getBackend().renameSourceDirectory(args.directory, args.newName)
  );
  ipcMain.handle('worker:generate-title', async (_event, args: { id: string; ocrText?: string }) => getBackend().generateTitle(args.id, args.ocrText));
  ipcMain.handle('worker:rename-one', async (_event, args: { id: string; suggestedTitle?: string }) => getBackend().renameOne(args.id, args.suggestedTitle));
  ipcMain.handle('worker:rename-all', async (_event, settings: AppSettingsInput) => getBackend().renameAll(settings));
}

app.whenReady().then(async () => {
  backend = new DesktopBackend({
    mainDir: __dirname,
    cwd: process.cwd(),
    userDataPath: app.getPath('userData'),
    env: process.env,
    platform: process.platform,
    secretCrypto: safeStorage,
    onWorkerEvent: broadcastWorkerEvent,
    onLifecycle: broadcastLifecycle
  });

  registerIpcHandlers();
  await createWindow();

  void backend.start().catch((error) => {
    broadcastLifecycle({
      state: 'error',
      message: error instanceof Error ? error.message : String(error)
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  void backend?.shutdown();
});
