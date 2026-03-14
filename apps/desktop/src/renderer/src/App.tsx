import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { AppSettings, AppSettingsInput, LanguageSetting, ProcessingItem, SupportedLanguage, WorkerLifecycleEvent } from '@videotitler/core';

import { applyRenamedSourceDirectoryItems, applyWorkerEvent, createInitialUiState, type UiState } from './app-state';
import { getUiText, resolveSystemLanguage } from './i18n';
import { VideoSummaryItem } from './components/VideoSummaryItem';

const SUPPORTED_LANGUAGES: SupportedLanguage[] = ['en', 'zh', 'fr'];

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

function getPathLeaf(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

export function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [secretDraft, setSecretDraft] = useState<SecretDraftState>(EMPTY_SECRETS);
  const [uiState, setUiState] = useState<UiState>(createInitialUiState);
  const [workerLifecycle, setWorkerLifecycle] = useState<WorkerLifecycleEvent>({
    state: 'starting',
    message: getUiText('en').waitingPreload
  });
  const [ocrDraft, setOcrDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [isRenamingSourceDirectory, setIsRenamingSourceDirectory] = useState(false);
  const [sourceDirectoryRenameDraft, setSourceDirectoryRenameDraft] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHydrating, setIsHydrating] = useState(true);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [fatalError, setFatalError] = useState('');
  const [detailCardHeight, setDetailCardHeight] = useState<number | null>(null);

  const api = typeof window !== 'undefined' ? window.videoTitlerApi : undefined;
  const detailCardRef = useRef<HTMLElement | null>(null);
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
  const canRenameSourceDirectory = Boolean(settings.inputDir.trim()) && !uiState.session.isProcessing && !isSavingSettings;
  const systemLanguage = useMemo<SupportedLanguage>(() => {
    if (typeof navigator === 'undefined') {
      return 'en';
    }
    return resolveSystemLanguage(navigator.language);
  }, []);
  const effectiveLanguage = settings.uiLanguage === 'system' ? systemLanguage : settings.uiLanguage;
  const i18n = getUiText(effectiveLanguage);
  const workspaceStyle = useMemo<CSSProperties | undefined>(() => {
    if (!detailCardHeight) {
      return undefined;
    }

    return {
      '--detail-card-height': `${detailCardHeight}px`
    } as CSSProperties;
  }, [detailCardHeight]);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const detailCard = detailCardRef.current;
    if (!detailCard) {
      return;
    }

    const mediaQueryList = window.matchMedia('(min-width: 1181px)');
    let frameId = 0;

    const applyMeasuredHeight = () => {
      if (!mediaQueryList.matches) {
        setDetailCardHeight(null);
        return;
      }

      const nextHeight = Math.round(detailCard.getBoundingClientRect().height);
      setDetailCardHeight((previous) => (previous === nextHeight ? previous : nextHeight));
    };

    const scheduleMeasure = () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        applyMeasuredHeight();
      });
    };

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          scheduleMeasure();
        });

    resizeObserver?.observe(detailCard);
    scheduleMeasure();

    const handleMediaChange = () => {
      scheduleMeasure();
    };

    window.addEventListener('resize', scheduleMeasure);
    if (typeof mediaQueryList.addEventListener === 'function') {
      mediaQueryList.addEventListener('change', handleMediaChange);
    } else {
      mediaQueryList.addListener(handleMediaChange);
    }

    return () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      if (typeof mediaQueryList.removeEventListener === 'function') {
        mediaQueryList.removeEventListener('change', handleMediaChange);
      } else {
        mediaQueryList.removeListener(handleMediaChange);
      }
    };
  }, []);

  useEffect(() => {
    if (!api) {
      setFatalError(i18n.preloadUnavailableDetail);
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

  useEffect(() => {
    if (!isRenamingSourceDirectory) {
      return;
    }

    setSourceDirectoryRenameDraft(getPathLeaf(settings.inputDir));
  }, [isRenamingSourceDirectory, settings.inputDir]);

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
      throw new Error(i18n.preloadUnavailableDetail);
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
      appendLog(i18n.addApiKeysBeforeRun);
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
      appendLog(i18n.directoryPickerFailed(formatError(error)));
    }
  };

  const handleOpenDirectory = async () => {
    if (!api || !settings.inputDir.trim()) {
      return;
    }

    try {
      await api.openDirectory(settings.inputDir);
    } catch (error) {
      appendLog(i18n.openDirectoryFailed(formatError(error)));
    }
  };

  const handleStartRenameSourceDirectory = () => {
    if (!settings.inputDir.trim()) {
      appendLog(i18n.selectSourceDirectoryFirst);
      return;
    }

    setSourceDirectoryRenameDraft(getPathLeaf(settings.inputDir));
    setIsRenamingSourceDirectory(true);
  };

  const handleCancelRenameSourceDirectory = () => {
    setIsRenamingSourceDirectory(false);
    setSourceDirectoryRenameDraft('');
  };

  const handleRenameSourceDirectory = async () => {
    if (!api) {
      return;
    }

    const currentDirectory = settings.inputDir.trim();
    const nextName = sourceDirectoryRenameDraft.trim();
    if (!currentDirectory) {
      appendLog(i18n.selectSourceDirectoryFirst);
      return;
    }
    if (!nextName) {
      appendLog(i18n.renameSourceDirectoryEmptyName);
      return;
    }
    if (nextName === getPathLeaf(currentDirectory)) {
      appendLog(i18n.renameSourceDirectoryUnchanged);
      return;
    }

    try {
      const result = await api.renameSourceDirectory(currentDirectory, nextName);
      setSettings((previous) => ({
        ...previous,
        inputDir: result.inputDir,
        recentDirs: result.recentDirs
      }));
      setUiState((previous) => applyRenamedSourceDirectoryItems(previous, result.items));
      setIsRenamingSourceDirectory(false);
      setSourceDirectoryRenameDraft('');
      appendLog(i18n.renameSourceDirectoryLog(result.inputDir));
    } catch (error) {
      appendLog(i18n.renameSourceDirectoryFailed(formatError(error)));
    }
  };

  const handleScan = async () => {
    if (!api) {
      return;
    }

    if (!settings.inputDir.trim()) {
      appendLog(i18n.selectSourceDirectoryFirst);
      return;
    }

    try {
      const savedSettings = await persistSettings();
      appendLog(i18n.scanningDirectoryLog(savedSettings.inputDir));
      await api.scanVideos({
        directory: savedSettings.inputDir,
        includeSubdirs: savedSettings.includeSubdirs
      });
    } catch (error) {
      appendLog(i18n.scanFailed(formatError(error)));
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
      appendLog(i18n.startProcessingFailed(formatError(error)));
    }
  };

  const handleStopProcessing = async () => {
    if (!api) {
      return;
    }

    try {
      await api.stopProcessing();
    } catch (error) {
      appendLog(i18n.stopRequestFailed(formatError(error)));
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
      appendLog(i18n.renameAllFailed(formatError(error)));
    }
  };

  const handleSaveOcr = async () => {
    if (!api || !selectedItem) {
      return;
    }

    try {
      const updatedItem = await api.saveOcrEdit(selectedItem.id, ocrDraft);
      setUiState((previous) => mergeReturnedItem(previous, updatedItem));
      appendLog(i18n.saveOcrLog(updatedItem.fileName));
    } catch (error) {
      appendLog(i18n.saveOcrFailed(formatError(error)));
    }
  };

  const handleSaveTitle = async () => {
    if (!api || !selectedItem) {
      return;
    }

    try {
      const updatedItem = await api.saveTitleEdit(selectedItem.id, titleDraft);
      setUiState((previous) => mergeReturnedItem(previous, updatedItem));
      appendLog(i18n.saveTitleLog(updatedItem.fileName));
    } catch (error) {
      appendLog(i18n.saveTitleFailed(formatError(error)));
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
      appendLog(i18n.generateTitleLog(updatedItem.fileName));
    } catch (error) {
      appendLog(i18n.generateTitleFailed(formatError(error)));
    }
  };

  const handleRenameSelected = async () => {
    if (!api || !selectedItem) {
      return;
    }

    try {
      const updatedItem = await api.renameOne(selectedItem.id, titleDraft);
      setUiState((previous) => mergeReturnedItem(previous, updatedItem));
      appendLog(i18n.renameSelectedLog(updatedItem.fileName));
    } catch (error) {
      appendLog(i18n.renameSelectedFailed(formatError(error)));
    }
  };

  if (fatalError) {
    return (
      <div className="fatal-shell">
        <div className="fatal-card">
          <p className="eyebrow">{i18n.appName}</p>
          <h1>{i18n.preloadUnavailableTitle}</h1>
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
            <p className="eyebrow">{i18n.appName}</p>
            <h1>{i18n.heroTitle}</h1>
            <p className="hero-copy">
              {i18n.heroCopy}
            </p>
          </div>

          <div className="hero-status">
            <span className={`lifecycle-badge lifecycle-${workerLifecycle.state}`}>{workerLifecycle.state}</span>
            <p>{workerLifecycle.message}</p>
            <strong>{i18n.itemsCount(uiState.items.length)}</strong>
          </div>
        </header>

        <section className="card control-bar">
          <div className="field directory-field">
            <label htmlFor="input-dir">{i18n.sourceDirectory}</label>
            <div className="directory-input-row">
              <input
                id="input-dir"
                value={settings.inputDir}
                onChange={(event) => setSettings((previous) => ({ ...previous, inputDir: event.target.value }))}
                placeholder={i18n.chooseDirectoryPlaceholder}
              />
              <button type="button" className="button secondary" onClick={handleSelectDirectory}>
                {i18n.browse}
              </button>
              <button type="button" className="button ghost" onClick={handleOpenDirectory} disabled={!settings.inputDir.trim()}>
                {i18n.open}
              </button>
              <button type="button" className="button ghost" onClick={handleStartRenameSourceDirectory} disabled={!canRenameSourceDirectory}>
                {i18n.renameSourceDirectory}
              </button>
            </div>
            {isRenamingSourceDirectory ? (
              <div className="directory-rename-row">
                <input
                  value={sourceDirectoryRenameDraft}
                  onChange={(event) => setSourceDirectoryRenameDraft(event.target.value)}
                  placeholder={i18n.renameSourceDirectoryPlaceholder}
                  aria-label={i18n.renameSourceDirectory}
                />
                <button type="button" className="button secondary" onClick={handleRenameSourceDirectory} disabled={!canRenameSourceDirectory}>
                  {i18n.renameSourceDirectoryConfirm}
                </button>
                <button type="button" className="button ghost" onClick={handleCancelRenameSourceDirectory}>
                  {i18n.cancel}
                </button>
              </div>
            ) : null}
          </div>

          <div className="control-grid">
            <label className="field compact">
              <span>{i18n.frame}</span>
              <input
                type="number"
                min={1}
                value={settings.frameNumber}
                onChange={(event) => setSettings((previous) => ({ ...previous, frameNumber: Math.max(1, Number(event.target.value) || 1) }))}
              />
            </label>

            <label className="field compact">
              <span>{i18n.startIndex}</span>
              <input
                type="number"
                min={1}
                value={settings.startIndex}
                onChange={(event) => setSettings((previous) => ({ ...previous, startIndex: Math.max(1, Number(event.target.value) || 1) }))}
              />
            </label>

            <label className="field compact">
              <span>{i18n.indexPadding}</span>
              <input
                type="number"
                min={1}
                max={8}
                value={settings.indexPadding}
                onChange={(event) => setSettings((previous) => ({ ...previous, indexPadding: Math.max(1, Number(event.target.value) || 1) }))}
              />
            </label>

            <label className="field compact">
              <span>{i18n.ocrMode}</span>
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
              <span>{i18n.includeSubdirs}</span>
            </label>

            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.dryRun}
                onChange={(event) => setSettings((previous) => ({ ...previous, dryRun: event.target.checked }))}
              />
              <span>{i18n.dryRun}</span>
            </label>
          </div>

          <div className="action-row">
            <button type="button" className="button secondary" onClick={handleScan} disabled={isHydrating || isSavingSettings}>
              {i18n.scanVideos}
            </button>
            <button type="button" className="button primary" onClick={handleStartProcessing} disabled={!canStartProcessing || isSavingSettings}>
              {i18n.startProcess}
            </button>
            <button type="button" className="button ghost" onClick={handleStopProcessing} disabled={!canStop}>
              {i18n.stopAfterCurrent}
            </button>
            <button type="button" className="button accent" onClick={handleRenameAll} disabled={!canRenameAll || isSavingSettings}>
              {i18n.renameAll}
            </button>
            <button type="button" className="button ghost" onClick={() => setIsSettingsOpen(true)}>
              {i18n.settings}
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

        <main className="workspace" style={workspaceStyle}>
          <section className="card table-card">
            <div className="section-header">
              <div>
                <p className="eyebrow">{i18n.batchList}</p>
                <h2>{i18n.scannedVideos}</h2>
              </div>
              <p>{uiState.items.length === 0 ? i18n.emptyTableHint : i18n.tableHint}</p>
            </div>

            {uiState.items.length === 0 ? (
              <div className="empty-state">
                <strong>{i18n.noVideosLoaded}</strong>
                <p>{i18n.stepsHint}</p>
              </div>
            ) : (
              <div className="video-summary-scroll" role="region" aria-label={i18n.scannedVideos}>
                <div className="video-summary-list" role="list">
                  {uiState.items.map((item) => (
                    <VideoSummaryItem
                      key={item.id}
                      item={item}
                      isSelected={item.id === uiState.selectedItemId}
                      fallbackIdleLabel={i18n.idle}
                      statusTone={getStatusTone(item)}
                      labels={{
                        file: i18n.tableFile,
                        status: i18n.tableStatus,
                        suggestedTitle: i18n.tableSuggestedTitle,
                        targetFilename: i18n.tableTargetFilename
                      }}
                      onSelect={() => setUiState((previous) => ({ ...previous, selectedItemId: item.id }))}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>

          <aside className="card detail-card" ref={detailCardRef}>
            <div className="section-header">
              <div>
                <p className="eyebrow">{i18n.reviewPane}</p>
                <h2>{selectedItem ? selectedItem.fileName : i18n.noSelection}</h2>
              </div>
              {selectedItem ? <p>{selectedItem.fullPath}</p> : <p>{i18n.selectRowHint}</p>}
            </div>

            <div className="preview-card">
              {selectedItem?.previewDataUrl ? (
                <img src={selectedItem.previewDataUrl} alt={selectedItem.fileName} className="preview-image" />
              ) : (
                <div className="preview-placeholder">{i18n.previewPlaceholder}</div>
              )}
            </div>

            <div className="meta-grid">
              <div className="meta-card">
                <span className="meta-label">{i18n.currentStatus}</span>
                <strong>{selectedItem?.status || i18n.idle}</strong>
              </div>
              <div className="meta-card">
                <span className="meta-label">{i18n.targetFilename}</span>
                <strong>{selectedItem?.newName || i18n.targetFilenameNotGenerated}</strong>
              </div>
            </div>

            {selectedItem?.error ? <div className="error-banner">{selectedItem.error}</div> : null}

            <div className="editor-block">
              <div className="editor-header">
                <h3>{i18n.ocrText}</h3>
                <button type="button" className="button ghost" onClick={handleSaveOcr} disabled={!selectedItem}>
                  {i18n.saveOcr}
                </button>
              </div>
              <textarea
                rows={10}
                value={ocrDraft}
                onChange={(event) => setOcrDraft(event.target.value)}
                placeholder={i18n.ocrPlaceholder}
                disabled={!selectedItem}
              />
            </div>

            <div className="editor-block">
              <div className="editor-header">
                <h3>{i18n.suggestedTitle}</h3>
                <button type="button" className="button ghost" onClick={handleSaveTitle} disabled={!selectedItem}>
                  {i18n.saveTitle}
                </button>
              </div>
              <textarea
                rows={4}
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                placeholder={i18n.titlePlaceholder}
                disabled={!selectedItem}
              />
            </div>

            <div className="detail-actions">
              <button type="button" className="button secondary" onClick={handleGenerateTitle} disabled={!selectedItem}>
                {i18n.generateTitleFromOcr}
              </button>
              <button type="button" className="button accent" onClick={handleRenameSelected} disabled={!selectedItem || uiState.session.isProcessing}>
                {i18n.renameSelected}
              </button>
            </div>
          </aside>
        </main>

        <section className="card log-card">
          <div className="section-header">
            <div>
              <p className="eyebrow">{i18n.logs}</p>
              <h2>{i18n.workerActivity}</h2>
            </div>
            <p>{i18n.entriesCount(uiState.logs.length)}</p>
          </div>

          <pre className="log-output">{uiState.logs.join('\n') || i18n.logsPlaceholder}</pre>
        </section>
      </div>

      <div className={`settings-drawer ${isSettingsOpen ? 'open' : ''}`} aria-hidden={!isSettingsOpen}>
        <div className="settings-backdrop" onClick={() => setIsSettingsOpen(false)} />
        <aside className="settings-panel">
          <div className="settings-header">
            <div>
              <p className="eyebrow">{i18n.settings}</p>
              <h2>{i18n.settingsSubtitle}</h2>
            </div>
            <button type="button" className="button ghost" onClick={() => setIsSettingsOpen(false)}>
              {i18n.close}
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
                <option value="system">{`${i18n.useSystemLanguage} (${getUiText(systemLanguage).languageLabel})`}</option>
                {SUPPORTED_LANGUAGES.map((language) => (
                  <option key={language} value={language}>
                    {i18n.languageName[language]}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="settings-section">
            <h3>{i18n.secureApiKeys}</h3>
            <div className="field">
              <label htmlFor="baidu-api-key">{i18n.baiduApiKey}</label>
              <input
                id="baidu-api-key"
                value={secretDraft.baiduApiKey}
                onChange={(event) => setSecretDraft((previous) => ({ ...previous, baiduApiKey: event.target.value, clearBaiduApiKey: false }))}
                placeholder={settings.secretsState.hasBaiduApiKey ? i18n.storedPlaceholderKey : i18n.pasteKeyPlaceholder}
              />
              <label className="toggle compact-toggle">
                <input
                  type="checkbox"
                  checked={secretDraft.clearBaiduApiKey}
                  onChange={(event) => setSecretDraft((previous) => ({ ...previous, clearBaiduApiKey: event.target.checked, baiduApiKey: event.target.checked ? '' : previous.baiduApiKey }))}
                />
                <span>{i18n.clearStoredKey}</span>
              </label>
            </div>

            <div className="field">
              <label htmlFor="baidu-secret-key">{i18n.baiduSecretKey}</label>
              <input
                id="baidu-secret-key"
                value={secretDraft.baiduSecretKey}
                onChange={(event) => setSecretDraft((previous) => ({ ...previous, baiduSecretKey: event.target.value, clearBaiduSecretKey: false }))}
                placeholder={settings.secretsState.hasBaiduSecretKey ? i18n.storedPlaceholderSecret : i18n.pasteSecretPlaceholder}
              />
              <label className="toggle compact-toggle">
                <input
                  type="checkbox"
                  checked={secretDraft.clearBaiduSecretKey}
                  onChange={(event) => setSecretDraft((previous) => ({ ...previous, clearBaiduSecretKey: event.target.checked, baiduSecretKey: event.target.checked ? '' : previous.baiduSecretKey }))}
                />
                <span>{i18n.clearStoredSecret}</span>
              </label>
            </div>

            <div className="field">
              <label htmlFor="deepseek-api-key">{i18n.deepseekApiKey}</label>
              <input
                id="deepseek-api-key"
                value={secretDraft.deepseekApiKey}
                onChange={(event) => setSecretDraft((previous) => ({ ...previous, deepseekApiKey: event.target.value, clearDeepseekApiKey: false }))}
                placeholder={settings.secretsState.hasDeepseekApiKey ? i18n.storedPlaceholderKey : i18n.pasteKeyPlaceholder}
              />
              <label className="toggle compact-toggle">
                <input
                  type="checkbox"
                  checked={secretDraft.clearDeepseekApiKey}
                  onChange={(event) => setSecretDraft((previous) => ({ ...previous, clearDeepseekApiKey: event.target.checked, deepseekApiKey: event.target.checked ? '' : previous.deepseekApiKey }))}
                />
                <span>{i18n.clearStoredKey}</span>
              </label>
            </div>

            <div className="presence-grid">
              <span className={settings.secretsState.hasBaiduApiKey ? 'presence present' : 'presence missing'}>{i18n.baiduApiKey}</span>
              <span className={settings.secretsState.hasBaiduSecretKey ? 'presence present' : 'presence missing'}>{i18n.baiduSecretKey}</span>
              <span className={settings.secretsState.hasDeepseekApiKey ? 'presence present' : 'presence missing'}>{i18n.deepseekApiKey}</span>
            </div>
          </section>

          <section className="settings-section">
            <h3>{i18n.deepseekRequestSettings}</h3>
            <label className="field">
              <span>{i18n.baseUrl}</span>
              <input
                value={settings.deepseekBaseUrl}
                onChange={(event) => setSettings((previous) => ({ ...previous, deepseekBaseUrl: event.target.value }))}
              />
            </label>

            <label className="field">
              <span>{i18n.model}</span>
              <input
                value={settings.deepseekModel}
                onChange={(event) => setSettings((previous) => ({ ...previous, deepseekModel: event.target.value }))}
              />
            </label>

            <label className="field">
              <span>{i18n.systemPrompt}</span>
              <textarea
                rows={5}
                value={settings.deepseekSystemPrompt}
                onChange={(event) => setSettings((previous) => ({ ...previous, deepseekSystemPrompt: event.target.value }))}
              />
            </label>

            <label className="field">
              <span>{i18n.userPromptTemplate}</span>
              <textarea
                rows={7}
                value={settings.deepseekUserPromptTemplate}
                onChange={(event) => setSettings((previous) => ({ ...previous, deepseekUserPromptTemplate: event.target.value }))}
              />
            </label>
          </section>

          <section className="settings-section">
            <h3>{i18n.recentDirectories}</h3>
            {settings.recentDirs.length === 0 ? (
              <p className="muted">{i18n.recentDirsEmpty}</p>
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
              {i18n.saveSettings}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
