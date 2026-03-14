import type { ProcessingItem, ProcessingSessionState, WorkerEvent } from '@videotitler/core';

export type UiState = {
  items: ProcessingItem[];
  selectedItemId: string | null;
  logs: string[];
  session: ProcessingSessionState;
};

export function createInitialSessionState(): ProcessingSessionState {
  return {
    isProcessing: false,
    activeCommand: 'idle',
    progressCurrent: 0,
    progressTotal: 0,
    lastDoneMessage: ''
  };
}

export function createInitialUiState(): UiState {
  return {
    items: [],
    selectedItemId: null,
    logs: [],
    session: createInitialSessionState()
  };
}

function updateItem(
  items: ProcessingItem[],
  itemId: string,
  updater: (item: ProcessingItem) => ProcessingItem
): ProcessingItem[] {
  return items.map((item) => (item.id === itemId ? updater(item) : item));
}

function selectAvailableItemId(items: ProcessingItem[], selectedItemId: string | null): string | null {
  if (selectedItemId && items.some((item) => item.id === selectedItemId)) {
    return selectedItemId;
  }

  return items[0]?.id ?? null;
}

export function applyRenamedSourceDirectoryItems(state: UiState, items: ProcessingItem[]): UiState {
  return {
    ...state,
    items,
    selectedItemId: selectAvailableItemId(items, state.selectedItemId)
  };
}

export function applyWorkerEvent(state: UiState, event: WorkerEvent): UiState {
  if (event.event === 'scan_result') {
    return {
      ...state,
      items: event.items,
      selectedItemId: selectAvailableItemId(event.items, state.selectedItemId),
      session: {
        ...state.session,
        progressCurrent: 0,
        progressTotal: event.items.length,
        lastDoneMessage: ''
      }
    };
  }

  if (event.event === 'item_preview') {
    return { ...state, items: updateItem(state.items, event.id, (item) => ({ ...item, previewDataUrl: event.previewDataUrl })) };
  }

  if (event.event === 'item_ocr') {
    return { ...state, items: updateItem(state.items, event.id, (item) => ({ ...item, ocrText: event.ocrText })) };
  }

  if (event.event === 'item_title') {
    return {
      ...state,
      items: updateItem(state.items, event.id, (item) => ({
        ...item,
        suggestedTitle: event.suggestedTitle,
        newName: event.newName
      }))
    };
  }

  if (event.event === 'item_status') {
    return {
      ...state,
      items: updateItem(state.items, event.id, (item) => ({
        ...item,
        status: event.status,
        error: event.error
      }))
    };
  }

  if (event.event === 'item_renamed') {
    return {
      ...state,
      items: updateItem(state.items, event.id, (item) => ({
        ...item,
        fullPath: event.fullPath,
        fileName: event.fileName,
        newName: event.newName,
        status: 'done',
        error: ''
      }))
    };
  }

  if (event.event === 'progress') {
    return {
      ...state,
      session: {
        ...state.session,
        progressCurrent: event.current,
        progressTotal: event.total
      }
    };
  }

  if (event.event === 'log') {
    return {
      ...state,
      logs: [...state.logs, event.message]
    };
  }

  if (event.event === 'done') {
    return {
      ...state,
      session: {
        ...state.session,
        isProcessing: false,
        activeCommand: 'idle',
        lastDoneMessage: event.message
      }
    };
  }

  if (event.event === 'error') {
    if (!event.id) {
      return {
        ...state,
        logs: [...state.logs, event.message]
      };
    }

    return {
      ...state,
      items: updateItem(state.items, event.id, (item) => ({
        ...item,
        status: 'error',
        error: event.message
      })),
      logs: [...state.logs, event.message]
    };
  }

  return state;
}
