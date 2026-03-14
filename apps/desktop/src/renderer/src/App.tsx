import { useEffect, useMemo, useState } from 'react';

import type { AppSettings, AppSettingsInput, LanguageSetting, ProcessingItem, SupportedLanguage, WorkerLifecycleEvent } from '@videotitler/core';

import { applyWorkerEvent, createInitialUiState, type UiState } from './app-state';


const SUPPORTED_LANGUAGES: SupportedLanguage[] = ['en', 'zh', 'fr'];

type I18nBundle = {
  languageLabel: string;
  useSystemLanguage: string;
  english: string;
  chinese: string;
  french: string;
  settingsSaved: string;
};

const I18N_TEXT: Record<SupportedLanguage, I18nBundle> = {
  en: {
    languageLabel: 'App language',
    useSystemLanguage: 'Follow system language',
    english: 'English',
    chinese: 'Chinese',
    french: 'French',
    settingsSaved: 'Settings saved.'
  },
  zh: {
    languageLabel: '界面语言',
    useSystemLanguage: '跟随系统语言',
    english: '英语',
    chinese: '中文',
    french: '法语',
    settingsSaved: '设置已保存。'
  },
  fr: {
    languageLabel: "Langue de l'application",
    useSystemLanguage: 'Suivre la langue du système',
    english: 'Anglais',
    chinese: 'Chinois',
    french: 'Français',
    settingsSaved: 'Paramètres enregistrés.'
  }
};

function normalizeSupportedLanguage(value: string): SupportedLanguage {
  const normalized = value.toLowerCase();
  if (normalized.startsWith('zh')) {
    return 'zh';
  }
  if (normalized.startsWith('fr')) {
    return 'fr';
  }
  return 'en';
}

type SecretDraftState = {
  baiduApiKey: string;
  baiduSecretKey: string;
  deepseekApiKey: string;
  clearBaiduApiKey: boolean;
  clearBaiduSecretKey: boolean;
  clearDeepseekApiKey: boolean;
};

const EMPTY_SECRETS: SecretDraftState = {
  baiduApiKey: '',
  baiduSecretKey: '',
  deepseekApiKey: '',
  clearBaiduApiKey: false,
  clearBaiduSecretKey: false,
  clearDeepseekApiKey: false
};

const DEFAULT_SETTINGS: AppSettings = {
  inputDir: '',
  includeSubdirs: false,
  frameNumber: 1,
  startIndex: 1,
  indexPadding: 3,
  dryRun: false,
  ocrMode: 'accurate_basic',
  deepseekBaseUrl: 'https://api.deepseek.com/v1',
  deepseekModel: 'deepseek-chat',
  deepseekSystemPrompt: 'Extract one short video title from the OCR text. Return the title only.',
  deepseekUserPromptTemplate: 'OCR text:\n{ocr_text}\n\nReturn one short title only.',
  uiLanguage: 'system',
  recentDirs: [],
  secretsState: {
    hasBaiduApiKey: false,
    hasBaiduSecretKey: false,
    hasDeepseekApiKey: false
  }
};

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildSettingsInput(settings: AppSettings, secretDraft: SecretDraftState): AppSettingsInput {
  return {
    inputDir: settings.inputDir,
    includeSubdirs: settings.includeSubdirs,
    frameNumber: settings.frameNumber,
    startIndex: settings.startIndex,
    indexPadding: settings.indexPadding,
    dryRun: settings.dryRun,
    ocrMode: settings.ocrMode,
    deepseekBaseUrl: settings.deepseekBaseUrl,
    deepseekModel: settings.deepseekModel,
    deepseekSystemPrompt: settings.deepseekSystemPrompt,
    deepseekUserPromptTemplate: settings.deepseekUserPromptTemplate,
    uiLanguage: settings.uiLanguage,
    recentDirs: settings.recentDirs,
    baiduApiKey: secretDraft.baiduApiKey,
    baiduSecretKey: secretDraft.baiduSecretKey,
    deepseekApiKey: secretDraft.deepseekApiKey,
    clearBaiduApiKey: secretDraft.clearBaiduApiKey,
    clearBaiduSecretKey: secretDraft.clearBaiduSecretKey,
    clearDeepseekApiKey: secretDraft.clearDeepseekApiKey
  };
}

function mergeReturnedItem(state: UiState, item: ProcessingItem): UiState {
  const existingIndex = state.items.findIndex((candidate) => candidate.id === item.id);
  const nextItems = existingIndex >= 0
    ? state.items.map((candidate) => (candidate.id === item.id ? item : candidate))
    : [...state.items, item];

  return {
    ...state,
    items: nextItems,
    selectedItemId: state.selectedItemId ?? item.id
  };
}

function hasEffectiveSecret(stored: boolean, currentValue: string, clearValue: boolean): boolean {
  if (clearValue) {
    return false;
  }

  return Boolean(currentValue.trim()) || stored;
}

function getStatusTone(item: ProcessingItem): 'error' | 'ready' | 'working' | 'idle' {
  const normalizedStatus = item.status.toLowerCase();
  if (item.error || normalizedStatus.includes('error')) {
    return 'error';
  }

  if (normalizedStatus.includes('ocr') || normalizedStatus.includes('deepseek') || normalizedStatus.includes('read')) {
    return 'working';
  }

  if (item.newName || normalizedStatus.includes('done') || normalizedStatus.includes('ready')) {
    return 'ready';
  }

  return 'idle';
}

export function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [secretDraft, setSecretDraft] = useState<SecretDraftState>(EMPTY_SECRETS);
  const [uiState, setUiState] = useState<UiState>(createInitialUiState);
  const [workerLifecycle, setWorkerLifecycle] = useState<WorkerLifecycleEvent>({
    state: 'starting',
    message: 'Waiting for Electron preload...'
  });
  const [ocrDraft, setOcrDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHydrating, setIsHydrating] = useState(true);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [fatalError, setFatalError] = useState('');

  const api = typeof window !== 'undefined' ? window.videoTitlerApi : undefined;
  const selectedItem = useMemo(
    () => uiState.items.find((item) => item.id === uiState.selectedItemId) ?? null,
    [uiState.items, uiState.selectedItemId]
  );
  const progressRatio = uiState.session.progressTotal > 0
    ? Math.min(100, Math.round((uiState.session.progressCurrent / uiState.session.progressTotal) * 100))
    : 0;
  const canStartProcessing = uiState.items.length > 0 && !uiState.session.isProcessing;
  const canRenameAll = uiState.items.length > 0 && !uiState.session.isProcessing;
  const canStop = uiState.session.isProcessing;
  const systemLanguage = useMemo<SupportedLanguage>(() => {
    if (typeof navigator === 'undefined') {
      return 'en';
    }
    return normalizeSupportedLanguage(navigator.language);
  }, []);
  const effectiveLanguage = settings.uiLanguage === 'system' ? systemLanguage : settings.uiLanguage;
  const i18n = I18N_TEXT[effectiveLanguage];

  useEffect(() => {
    if (!api) {
      setFatalError('The preload bridge is unavailable. Restart Electron and verify the preload bundle is loading.');
      return;
    }

    let isMounted = true;
    const unsubscribeEvent = api.onWorkerEvent((event) => {
      if (!isMounted) {
        return;
      }

      setUiState((previous) => applyWorkerEvent(previous, event));
    });

    const unsubscribeLifecycle = api.onWorkerLifecycle((event) => {
      if (!isMounted) {
        return;
      }

      setWorkerLifecycle(event);
      setUiState((previous) => ({
        ...previous,
        logs: [...previous.logs, `[worker:${event.state}] ${event.message}`],
        session: event.state === 'error' || event.state === 'stopped'
          ? {
              ...previous.session,
              isProcessing: false,
              activeCommand: 'idle'
            }
          : previous.session
      }));
    });

    api.loadSettings()
      .then((loadedSettings) => {
        if (!isMounted) {
          return;
        }
        setSettings(loadedSettings);
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }
        setUiState((previous) => ({
          ...previous,
          logs: [...previous.logs, `[ui:error] ${formatError(error)}`]
        }));
      })
      .finally(() => {
        if (isMounted) {
          setIsHydrating(false);
        }
      });

    return () => {
      isMounted = false;
      unsubscribeEvent();
      unsubscribeLifecycle();
    };
  }, [api]);

  useEffect(() => {
    setOcrDraft(selectedItem?.ocrText ?? '');
    setTitleDraft(selectedItem?.suggestedTitle ?? '');
  }, [selectedItem?.id, selectedItem?.ocrText, selectedItem?.suggestedTitle]);

  const appendLog = (message: string) => {
    setUiState((previous) => ({
      ...previous,
      logs: [...previous.logs, `[ui] ${message}`]
    }));
  };

  const applySavedSettings = (savedSettings: AppSettings) => {
    setSettings(savedSettings);
    setSecretDraft(EMPTY_SECRETS);
  };

  const persistSettings = async (options?: { announce?: boolean }): Promise<AppSettings> => {
    if (!api) {
      throw new Error('Electron preload API is unavailable.');
    }

    setIsSavingSettings(true);
    try {
      const savedSettings = await api.saveSettings(buildSettingsInput(settings, secretDraft));
      applySavedSettings(savedSettings);
      if (options?.announce) {
        appendLog(i18n.settingsSaved);
      }
      return savedSettings;
    } finally {
      setIsSavingSettings(false);
    }
  };

  const ensureSecretsReady = (): boolean => {
    const ready = hasEffectiveSecret(
      settings.secretsState.hasBaiduApiKey,
      secretDraft.baiduApiKey,
      secretDraft.clearBaiduApiKey
    ) && hasEffectiveSecret(
      settings.secretsState.hasBaiduSecretKey,
      secretDraft.baiduSecretKey,
      secretDraft.clearBaiduSecretKey
    ) && hasEffectiveSecret(
      settings.secretsState.hasDeepseekApiKey,
      secretDraft.deepseekApiKey,
      secretDraft.clearDeepseekApiKey
    );

    if (!ready) {
      setIsSettingsOpen(true);
      appendLog('Add the required API keys in Settings before running OCR and title extraction.');
    }

    return ready;
  };

  const handleSelectDirectory = async () => {
    if (!api) {
      return;
    }

    try {
      const selectedDirectory = await api.selectDirectory(settings.inputDir);
      if (selectedDirectory) {
        setSettings((previous) => ({ ...previous, inputDir: selectedDirectory }));
      }
    } catch (error) {
      appendLog(`Directory picker failed: ${formatError(error)}`);
    }
  };

  const handleOpenDirectory = async () => {
    if (!api || !settings.inputDir.trim()) {
      return;
    }

    try {
      await api.openDirectory(settings.inputDir);
    } catch (error) {
      appendLog(`Open directory failed: ${formatError(error)}`);
    }
  };

  const handleScan = async () => {
    if (!api) {
      return;
    }

    if (!settings.inputDir.trim()) {
      appendLog('Select or enter a source directory first.');
      return;
    }

    try {
      const savedSettings = await persistSettings();
      appendLog(`Scanning ${savedSettings.inputDir}...`);
      await api.scanVideos({
        directory: savedSettings.inputDir,
        includeSubdirs: savedSettings.includeSubdirs
      });
    } catch (error) {
      appendLog(`Scan failed: ${formatError(error)}`);
    }
  };

  const handleStartProcessing = async () => {
    if (!api) {
      return;
    }

    if (!canStartProcessing) {
      return;
    }

    if (!ensureSecretsReady()) {
      return;
    }

    try {
      const savedSettings = await persistSettings();
      setUiState((previous) => ({
        ...previous,
        session: {
          ...previous.session,
          isProcessing: true,
          activeCommand: 'processing',
          progressCurrent: 0,
          progressTotal: previous.items.length,
          lastDoneMessage: ''
        }
      }));
      await api.startProcessing(buildSettingsInput(savedSettings, EMPTY_SECRETS));
    } catch (error) {
      setUiState((previous) => ({
        ...previous,
        session: {
          ...previous.session,
          isProcessing: false,
          activeCommand: 'idle'
        }
      }));
      appendLog(`Start processing failed: ${formatError(error)}`);
    }
  };

  const handleStopProcessing = async () => {
    if (!api) {
      return;
    }

    try {
      await api.stopProcessing();
    } catch (error) {
      appendLog(`Stop request failed: ${formatError(error)}`);
    }
  };

  const handleRenameAll = async () => {
    if (!api || !canRenameAll) {
      return;
    }

    try {
      const savedSettings = await persistSettings();
      setUiState((previous) => ({
        ...previous,
        session: {
          ...previous.session,
          isProcessing: true,
          activeCommand: 'renaming',
          progressCurrent: 0,
          progressTotal: previous.items.length,
          lastDoneMessage: ''
        }
      }));
      await api.renameAll(buildSettingsInput(savedSettings, EMPTY_SECRETS));
    } catch (error) {
      setUiState((previous) => ({
        ...previous,
        session: {
          ...previous.session,
          isProcessing: false,
          activeCommand: 'idle'
        }
      }));
      appendLog(`Rename all failed: ${formatError(error)}`);
    }
  };

  const handleSaveOcr = async () => {
    if (!api || !selectedItem) {
      return;
    }

    try {
      const updatedItem = await api.saveOcrEdit(selectedItem.id, ocrDraft);
      setUiState((previous) => mergeReturnedItem(previous, updatedItem));
      appendLog(`Saved OCR edits for ${updatedItem.fileName}.`);
    } catch (error) {
      appendLog(`Save OCR failed: ${formatError(error)}`);
    }
  };

  const handleSaveTitle = async () => {
    if (!api || !selectedItem) {
      return;
    }

    try {
      const updatedItem = await api.saveTitleEdit(selectedItem.id, titleDraft);
      setUiState((previous) => mergeReturnedItem(previous, updatedItem));
      appendLog(`Saved title edits for ${updatedItem.fileName}.`);
    } catch (error) {
      appendLog(`Save title failed: ${formatError(error)}`);
    }
  };

  const handleGenerateTitle = async () => {
    if (!api || !selectedItem) {
      return;
    }

    if (!ensureSecretsReady()) {
      return;
    }

    try {
      const updatedItem = await api.generateTitle(selectedItem.id, ocrDraft);
      setUiState((previous) => mergeReturnedItem(previous, updatedItem));
      appendLog(`Generated title for ${updatedItem.fileName}.`);
    } catch (error) {
      appendLog(`Generate title failed: ${formatError(error)}`);
    }
  };

  const handleRenameSelected = async () => {
    if (!api || !selectedItem) {
      return;
    }

    try {
      const updatedItem = await api.renameOne(selectedItem.id, titleDraft);
      setUiState((previous) => mergeReturnedItem(previous, updatedItem));
      appendLog(`Renamed ${updatedItem.fileName}.`);
    } catch (error) {
      appendLog(`Rename selected failed: ${formatError(error)}`);
    }
  };

  if (fatalError) {
    return (
      <div className="fatal-shell">
        <div className="fatal-card">
          <p className="eyebrow">VideoTitler Desktop</p>
          <h1>Preload bridge unavailable</h1>
          <p>{fatalError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="shell">
        <header className="hero card">
          <div>
            <p className="eyebrow">VideoTitler Desktop</p>
            <h1>Electron dashboard for the full OCR + title workflow</h1>
            <p className="hero-copy">
              Scan a directory, extract preview frames, run OCR, generate titles, review edits, and rename one file or the full batch.
            </p>
          </div>

          <div className="hero-status">
            <span className={`lifecycle-badge lifecycle-${workerLifecycle.state}`}>{workerLifecycle.state}</span>
            <p>{workerLifecycle.message}</p>
            <strong>{uiState.items.length} items</strong>
          </div>
        </header>

        <section className="card control-bar">
          <div className="field directory-field">
            <label htmlFor="input-dir">Source directory</label>
            <div className="directory-input-row">
              <input
                id="input-dir"
                value={settings.inputDir}
                onChange={(event) => setSettings((previous) => ({ ...previous, inputDir: event.target.value }))}
                placeholder="Choose or paste a directory path"
              />
              <button type="button" className="button secondary" onClick={handleSelectDirectory}>
                Browse
              </button>
              <button type="button" className="button ghost" onClick={handleOpenDirectory} disabled={!settings.inputDir.trim()}>
                Open
              </button>
            </div>
          </div>

          <div className="control-grid">
            <label className="field compact">
              <span>Frame</span>
              <input
                type="number"
                min={1}
                value={settings.frameNumber}
                onChange={(event) => setSettings((previous) => ({ ...previous, frameNumber: Math.max(1, Number(event.target.value) || 1) }))}
              />
            </label>

            <label className="field compact">
              <span>Start index</span>
              <input
                type="number"
                min={1}
                value={settings.startIndex}
                onChange={(event) => setSettings((previous) => ({ ...previous, startIndex: Math.max(1, Number(event.target.value) || 1) }))}
              />
            </label>

            <label className="field compact">
              <span>Index padding</span>
              <input
                type="number"
                min={1}
                max={8}
                value={settings.indexPadding}
                onChange={(event) => setSettings((previous) => ({ ...previous, indexPadding: Math.max(1, Number(event.target.value) || 1) }))}
              />
            </label>

            <label className="field compact">
              <span>OCR mode</span>
              <select
                value={settings.ocrMode}
                onChange={(event) => setSettings((previous) => ({ ...previous, ocrMode: event.target.value as AppSettings['ocrMode'] }))}
              >
                <option value="accurate_basic">accurate_basic</option>
                <option value="general_basic">general_basic</option>
              </select>
            </label>
          </div>

          <div className="toggle-row">
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.includeSubdirs}
                onChange={(event) => setSettings((previous) => ({ ...previous, includeSubdirs: event.target.checked }))}
              />
              <span>Include subdirectories</span>
            </label>

            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.dryRun}
                onChange={(event) => setSettings((previous) => ({ ...previous, dryRun: event.target.checked }))}
              />
              <span>Dry run / preview only</span>
            </label>
          </div>

          <div className="action-row">
            <button type="button" className="button secondary" onClick={handleScan} disabled={isHydrating || isSavingSettings}>
              Scan videos
            </button>
            <button type="button" className="button primary" onClick={handleStartProcessing} disabled={!canStartProcessing || isSavingSettings}>
              Start OCR + title extraction
            </button>
            <button type="button" className="button ghost" onClick={handleStopProcessing} disabled={!canStop}>
              Stop after current file
            </button>
            <button type="button" className="button accent" onClick={handleRenameAll} disabled={!canRenameAll || isSavingSettings}>
              Rename all
            </button>
            <button type="button" className="button ghost" onClick={() => setIsSettingsOpen(true)}>
              Settings
            </button>
          </div>

          <div className="progress-strip">
            <div className="progress-copy">
              <strong>{uiState.session.activeCommand}</strong>
              <span>
                {uiState.session.progressCurrent}/{uiState.session.progressTotal}
                {uiState.session.lastDoneMessage ? ` - ${uiState.session.lastDoneMessage}` : ''}
              </span>
            </div>
            <div className="progress-track" aria-hidden="true">
              <div className="progress-fill" style={{ width: `${progressRatio}%` }} />
            </div>
          </div>
        </section>

        <main className="workspace">
          <section className="card table-card">
            <div className="section-header">
              <div>
                <p className="eyebrow">Batch list</p>
                <h2>Scanned videos</h2>
              </div>
              <p>{uiState.items.length === 0 ? 'Choose a directory and scan to populate the table.' : 'Select a row to inspect preview, OCR, title, and rename actions.'}</p>
            </div>

            {uiState.items.length === 0 ? (
              <div className="empty-state">
                <strong>No videos loaded yet</strong>
                <p>1. Select a directory. 2. Scan. 3. Start processing. 4. Review and rename.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="results-table">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Status</th>
                      <th>Suggested title</th>
                      <th>Target filename</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uiState.items.map((item) => (
                      <tr
                        key={item.id}
                        data-selected={item.id === uiState.selectedItemId}
                        onClick={() => setUiState((previous) => ({ ...previous, selectedItemId: item.id }))}
                      >
                        <td>
                          <strong>{item.fileName}</strong>
                          <span className="table-path">{item.fullPath}</span>
                        </td>
                        <td>
                          <span className={`status-pill status-${getStatusTone(item)}`}>{item.status || 'idle'}</span>
                        </td>
                        <td>{item.suggestedTitle || '-'}</td>
                        <td>{item.newName || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <aside className="card detail-card">
            <div className="section-header">
              <div>
                <p className="eyebrow">Review pane</p>
                <h2>{selectedItem ? selectedItem.fileName : 'No selection'}</h2>
              </div>
              {selectedItem ? <p>{selectedItem.fullPath}</p> : <p>Select a row to view details.</p>}
            </div>

            <div className="preview-card">
              {selectedItem?.previewDataUrl ? (
                <img src={selectedItem.previewDataUrl} alt={selectedItem.fileName} className="preview-image" />
              ) : (
                <div className="preview-placeholder">Preview frame will appear here after processing.</div>
              )}
            </div>

            <div className="meta-grid">
              <div className="meta-card">
                <span className="meta-label">Current status</span>
                <strong>{selectedItem?.status || 'idle'}</strong>
              </div>
              <div className="meta-card">
                <span className="meta-label">Target filename</span>
                <strong>{selectedItem?.newName || 'Not generated yet'}</strong>
              </div>
            </div>

            {selectedItem?.error ? <div className="error-banner">{selectedItem.error}</div> : null}

            <div className="editor-block">
              <div className="editor-header">
                <h3>OCR text</h3>
                <button type="button" className="button ghost" onClick={handleSaveOcr} disabled={!selectedItem}>
                  Save OCR
                </button>
              </div>
              <textarea
                rows={10}
                value={ocrDraft}
                onChange={(event) => setOcrDraft(event.target.value)}
                placeholder="OCR text appears here after processing. You can edit and save it."
                disabled={!selectedItem}
              />
            </div>

            <div className="editor-block">
              <div className="editor-header">
                <h3>Suggested title</h3>
                <button type="button" className="button ghost" onClick={handleSaveTitle} disabled={!selectedItem}>
                  Save title
                </button>
              </div>
              <textarea
                rows={4}
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                placeholder="Title suggestion appears here. Edit before renaming if needed."
                disabled={!selectedItem}
              />
            </div>

            <div className="detail-actions">
              <button type="button" className="button secondary" onClick={handleGenerateTitle} disabled={!selectedItem}>
                Generate title from OCR
              </button>
              <button type="button" className="button accent" onClick={handleRenameSelected} disabled={!selectedItem || uiState.session.isProcessing}>
                Rename selected
              </button>
            </div>
          </aside>
        </main>

        <section className="card log-card">
          <div className="section-header">
            <div>
              <p className="eyebrow">Logs</p>
              <h2>Worker + UI activity</h2>
            </div>
            <p>{uiState.logs.length} entries</p>
          </div>

          <pre className="log-output">{uiState.logs.join('\n') || 'Logs will appear here as you scan, process, edit, and rename videos.'}</pre>
        </section>
      </div>

      <div className={`settings-drawer ${isSettingsOpen ? 'open' : ''}`} aria-hidden={!isSettingsOpen}>
        <div className="settings-backdrop" onClick={() => setIsSettingsOpen(false)} />
        <aside className="settings-panel">
          <div className="settings-header">
            <div>
              <p className="eyebrow">Settings</p>
              <h2>Secrets, prompts, and recent directories</h2>
            </div>
            <button type="button" className="button ghost" onClick={() => setIsSettingsOpen(false)}>
              Close
            </button>
          </div>

          <section className="settings-section">
            <h3>{i18n.languageLabel}</h3>
            <label className="field">
              <span>{i18n.languageLabel}</span>
              <select
                value={settings.uiLanguage}
                onChange={(event) => setSettings((previous) => ({ ...previous, uiLanguage: event.target.value as LanguageSetting }))}
              >
                <option value="system">{`${i18n.useSystemLanguage} (${I18N_TEXT[systemLanguage].languageLabel})`}</option>
                {SUPPORTED_LANGUAGES.map((language) => (
                  <option key={language} value={language}>
                    {language === 'en' ? i18n.english : language === 'zh' ? i18n.chinese : i18n.french}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="settings-section">
            <h3>Secure API keys</h3>
            <div className="field">
              <label htmlFor="baidu-api-key">Baidu API key</label>
              <input
                id="baidu-api-key"
                value={secretDraft.baiduApiKey}
                onChange={(event) => setSecretDraft((previous) => ({ ...previous, baiduApiKey: event.target.value, clearBaiduApiKey: false }))}
                placeholder={settings.secretsState.hasBaiduApiKey ? 'Stored securely - leave blank to keep current value' : 'Paste a key to store securely'}
              />
              <label className="toggle compact-toggle">
                <input
                  type="checkbox"
                  checked={secretDraft.clearBaiduApiKey}
                  onChange={(event) => setSecretDraft((previous) => ({ ...previous, clearBaiduApiKey: event.target.checked, baiduApiKey: event.target.checked ? '' : previous.baiduApiKey }))}
                />
                <span>Clear stored key</span>
              </label>
            </div>

            <div className="field">
              <label htmlFor="baidu-secret-key">Baidu secret key</label>
              <input
                id="baidu-secret-key"
                value={secretDraft.baiduSecretKey}
                onChange={(event) => setSecretDraft((previous) => ({ ...previous, baiduSecretKey: event.target.value, clearBaiduSecretKey: false }))}
                placeholder={settings.secretsState.hasBaiduSecretKey ? 'Stored securely - leave blank to keep current value' : 'Paste a secret to store securely'}
              />
              <label className="toggle compact-toggle">
                <input
                  type="checkbox"
                  checked={secretDraft.clearBaiduSecretKey}
                  onChange={(event) => setSecretDraft((previous) => ({ ...previous, clearBaiduSecretKey: event.target.checked, baiduSecretKey: event.target.checked ? '' : previous.baiduSecretKey }))}
                />
                <span>Clear stored secret</span>
              </label>
            </div>

            <div className="field">
              <label htmlFor="deepseek-api-key">DeepSeek API key</label>
              <input
                id="deepseek-api-key"
                value={secretDraft.deepseekApiKey}
                onChange={(event) => setSecretDraft((previous) => ({ ...previous, deepseekApiKey: event.target.value, clearDeepseekApiKey: false }))}
                placeholder={settings.secretsState.hasDeepseekApiKey ? 'Stored securely - leave blank to keep current value' : 'Paste a key to store securely'}
              />
              <label className="toggle compact-toggle">
                <input
                  type="checkbox"
                  checked={secretDraft.clearDeepseekApiKey}
                  onChange={(event) => setSecretDraft((previous) => ({ ...previous, clearDeepseekApiKey: event.target.checked, deepseekApiKey: event.target.checked ? '' : previous.deepseekApiKey }))}
                />
                <span>Clear stored key</span>
              </label>
            </div>

            <div className="presence-grid">
              <span className={settings.secretsState.hasBaiduApiKey ? 'presence present' : 'presence missing'}>Baidu API key</span>
              <span className={settings.secretsState.hasBaiduSecretKey ? 'presence present' : 'presence missing'}>Baidu secret</span>
              <span className={settings.secretsState.hasDeepseekApiKey ? 'presence present' : 'presence missing'}>DeepSeek API key</span>
            </div>
          </section>

          <section className="settings-section">
            <h3>DeepSeek request settings</h3>
            <label className="field">
              <span>Base URL</span>
              <input
                value={settings.deepseekBaseUrl}
                onChange={(event) => setSettings((previous) => ({ ...previous, deepseekBaseUrl: event.target.value }))}
              />
            </label>

            <label className="field">
              <span>Model</span>
              <input
                value={settings.deepseekModel}
                onChange={(event) => setSettings((previous) => ({ ...previous, deepseekModel: event.target.value }))}
              />
            </label>

            <label className="field">
              <span>System prompt</span>
              <textarea
                rows={5}
                value={settings.deepseekSystemPrompt}
                onChange={(event) => setSettings((previous) => ({ ...previous, deepseekSystemPrompt: event.target.value }))}
              />
            </label>

            <label className="field">
              <span>User prompt template</span>
              <textarea
                rows={7}
                value={settings.deepseekUserPromptTemplate}
                onChange={(event) => setSettings((previous) => ({ ...previous, deepseekUserPromptTemplate: event.target.value }))}
              />
            </label>
          </section>

          <section className="settings-section">
            <h3>Recent directories</h3>
            {settings.recentDirs.length === 0 ? (
              <p className="muted">Recent directories appear here after you save or run commands.</p>
            ) : (
              <div className="recent-list">
                {settings.recentDirs.map((directory) => (
                  <button
                    key={directory}
                    type="button"
                    className="recent-chip"
                    onClick={() => {
                      setSettings((previous) => ({ ...previous, inputDir: directory }));
                      setIsSettingsOpen(false);
                    }}
                  >
                    {directory}
                  </button>
                ))}
              </div>
            )}
          </section>

          <div className="settings-footer">
            <button type="button" className="button secondary" onClick={() => void persistSettings({ announce: true })} disabled={isSavingSettings}>
              Save settings
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
