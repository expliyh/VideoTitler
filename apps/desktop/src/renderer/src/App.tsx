import { useMemo } from 'react';
import { useAppStore } from './store';

export function App() {
  const { directory, frameNumber, videos, logs } = useAppStore();
  const { setDirectory, setFrameNumber, setVideos, mergeVideo, appendLogs } = useAppStore();

  const selectedIds = useMemo(() => videos.map((item) => item.id), [videos]);

  const onSelectDirectory = async () => {
    const selected = await window.videoTitlerApi.selectDirectory();
    if (selected) setDirectory(selected);
  };

  const onScan = async () => {
    if (!directory) return;
    const result = await window.videoTitlerApi.scanVideos(directory, frameNumber);
    setVideos(result.videos);
    appendLogs(result.logs);
  };

  const onUpdateFrame = async () => {
    if (selectedIds.length === 0) return;
    const result = await window.videoTitlerApi.updateFrameNumber(selectedIds, frameNumber);
    result.videos.forEach(mergeVideo);
    appendLogs(result.logs);
  };

  const onGenerateTitle = async (id: string, ocrText?: string) => {
    const result = await window.videoTitlerApi.generateTitle(id, ocrText);
    if (result.video) mergeVideo(result.video);
    appendLogs(result.logs);
  };

  const onRenameOne = async (id: string, index: number) => {
    const result = await window.videoTitlerApi.renameOne(id, index);
    if (result.video) mergeVideo(result.video);
    appendLogs(result.logs);
  };

  const onRenameAll = async () => {
    const result = await window.videoTitlerApi.renameAll(selectedIds);
    result.videos.forEach(mergeVideo);
    appendLogs(result.logs);
  };

  return (
    <div className="page">
      <h1>VideoTitler Desktop (React + Electron)</h1>

      <section className="card controls">
        <h2>目录扫描 / 帧号设置</h2>
        <div className="row">
          <button onClick={onSelectDirectory}>选择目录</button>
          <input value={directory} readOnly placeholder="未选择目录" />
          <button onClick={onScan} disabled={!directory}>扫描</button>
        </div>
        <div className="row">
          <label>第 X 帧(从 1 开始)</label>
          <input
            type="number"
            min={1}
            value={frameNumber}
            onChange={(event) => setFrameNumber(Number(event.target.value) || 1)}
          />
          <button onClick={onUpdateFrame} disabled={videos.length === 0}>批量更新帧号</button>
          <button onClick={onRenameAll} disabled={videos.length === 0}>批量重命名</button>
        </div>
      </section>

      <section className="card">
        <h2>OCR 结果编辑 / 单条重命名</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>视频文件</th>
              <th>OCR 文本</th>
              <th>建议标题</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {videos.map((video, index) => (
              <tr key={video.id}>
                <td>{index + 1}</td>
                <td>{video.fileName}</td>
                <td>
                  <textarea
                    value={video.ocrText}
                    rows={3}
                    onChange={(event) => mergeVideo({ ...video, ocrText: event.target.value })}
                  />
                </td>
                <td>
                  <input
                    value={video.suggestedTitle}
                    onChange={(event) => mergeVideo({ ...video, suggestedTitle: event.target.value })}
                  />
                </td>
                <td>
                  <div className="row">
                    <button onClick={() => onGenerateTitle(video.id, video.ocrText)}>生成标题</button>
                    <button onClick={() => onRenameOne(video.id, index + 1)}>重命名</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>日志</h2>
        <pre>{logs.join('\n')}</pre>
      </section>
    </div>
  );
}
