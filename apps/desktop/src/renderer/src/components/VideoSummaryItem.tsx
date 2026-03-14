import type { ProcessingItem } from '@videotitler/core';

type VideoSummaryItemProps = {
  item: ProcessingItem;
  isSelected: boolean;
  fallbackIdleLabel: string;
  onSelect: () => void;
  labels: {
    file: string;
    status: string;
    suggestedTitle: string;
    targetFilename: string;
  };
  statusTone: 'error' | 'ready' | 'working' | 'idle';
};

export function VideoSummaryItem({
  item,
  isSelected,
  fallbackIdleLabel,
  onSelect,
  labels,
  statusTone
}: VideoSummaryItemProps) {
  return (
    <article
      className="video-summary-item"
      data-selected={isSelected}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="video-summary-grid">
        <div className="video-summary-cell">
          <span className="video-summary-label">{labels.file}</span>
          <strong className="video-summary-primary">{item.fileName}</strong>
          <span className="table-path">{item.fullPath}</span>
        </div>

        <div className="video-summary-cell video-summary-cell-status">
          <span className="video-summary-label">{labels.status}</span>
          <span className={`status-pill status-${statusTone}`}>{item.status || fallbackIdleLabel}</span>
        </div>

        <div className="video-summary-cell">
          <span className="video-summary-label">{labels.suggestedTitle}</span>
          <span className="video-summary-value">{item.suggestedTitle || '-'}</span>
        </div>

        <div className="video-summary-cell">
          <span className="video-summary-label">{labels.targetFilename}</span>
          <span className="video-summary-value">{item.newName || '-'}</span>
        </div>
      </div>
    </article>
  );
}
