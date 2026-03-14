import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProcessingItem, ProcessingSessionState } from '@videotitler/core';
import { applyWorkerEvent, createInitialSessionState, createInitialUiState } from './app-state.ts';

function makeItem(overrides: Partial<ProcessingItem> = {}): ProcessingItem {
  return {
    id: 'item-1',
    fileName: 'clip.mp4',
    fullPath: 'C:/videos/clip.mp4',
    status: 'idle',
    ocrText: '',
    suggestedTitle: '',
    newName: '',
    error: '',
    previewDataUrl: '',
    ...overrides
  };
}

test('applyWorkerEvent merges per-item updates into the current item list', () => {
  const initial = createInitialUiState();
  initial.items = [makeItem()];

  const withPreview = applyWorkerEvent(initial, {
    event: 'item_preview',
    id: 'item-1',
    previewDataUrl: 'data:image/png;base64,abc'
  });
  const withOcr = applyWorkerEvent(withPreview, {
    event: 'item_ocr',
    id: 'item-1',
    ocrText: 'OCR TEXT'
  });
  const withTitle = applyWorkerEvent(withOcr, {
    event: 'item_title',
    id: 'item-1',
    suggestedTitle: 'New Title',
    newName: '001-New Title.mp4'
  });

  assert.deepEqual(withTitle.items[0], {
    ...makeItem(),
    previewDataUrl: 'data:image/png;base64,abc',
    ocrText: 'OCR TEXT',
    suggestedTitle: 'New Title',
    newName: '001-New Title.mp4'
  });
});

test('applyWorkerEvent updates progress, rename state, and appends logs', () => {
  const initial = createInitialUiState();
  initial.items = [makeItem()];
  initial.session = {
    ...createInitialSessionState(),
    isProcessing: true,
    activeCommand: 'processing'
  } as ProcessingSessionState;

  const withRename = applyWorkerEvent(initial, {
    event: 'item_renamed',
    id: 'item-1',
    oldFullPath: 'C:/videos/clip.mp4',
    oldFileName: 'clip.mp4',
    fullPath: 'C:/videos/001-New Title.mp4',
    fileName: '001-New Title.mp4',
    newName: '001-New Title.mp4'
  });
  const withProgress = applyWorkerEvent(withRename, {
    event: 'progress',
    current: 1,
    total: 3
  });
  const withLog = applyWorkerEvent(withProgress, {
    event: 'log',
    message: 'processing item'
  });
  const done = applyWorkerEvent(withLog, {
    event: 'done',
    message: 'completed'
  });

  assert.equal(done.items[0]?.fileName, '001-New Title.mp4');
  assert.equal(done.session.progressCurrent, 1);
  assert.equal(done.session.progressTotal, 3);
  assert.equal(done.session.isProcessing, false);
  assert.equal(done.session.activeCommand, 'idle');
  assert.equal(done.session.lastDoneMessage, 'completed');
  assert.deepEqual(done.logs, ['processing item']);
});

test('applyWorkerEvent replaces the list on scan and selects the first row when needed', () => {
  const initial = createInitialUiState();

  const next = applyWorkerEvent(initial, {
    event: 'scan_result',
    items: [
      makeItem({ id: 'item-1', fileName: 'clip1.mp4' }),
      makeItem({ id: 'item-2', fileName: 'clip2.mp4', fullPath: 'C:/videos/clip2.mp4' })
    ]
  });

  assert.equal(next.items.length, 2);
  assert.equal(next.selectedItemId, 'item-1');
});
