from __future__ import annotations

import base64
import json
import re
import threading
import traceback
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from videotitler.baidu_ocr import BaiduOcrClient
from videotitler.config import AppConfig, load_non_secret_config, save_non_secret_config
from videotitler.deepseek import extract_title_sentence
from videotitler.rename import build_target_path, pick_non_conflicting_path
from videotitler.video import extract_frame_as_png_bytes


VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}


def _natural_key(name: str) -> list[object]:
    parts = re.split(r"(\d+)", name)
    key: list[object] = []
    for part in parts:
        if part.isdigit():
            key.append(int(part))
        else:
            key.append(part.lower())
    return key


def scan_videos(root_dir: Path, *, include_subdirs: bool) -> list[Path]:
    if include_subdirs:
        candidates = [path for path in root_dir.rglob("*") if path.is_file()]
    else:
        candidates = [path for path in root_dir.iterdir() if path.is_file()]

    videos = [path for path in candidates if path.suffix.lower() in VIDEO_EXTS]
    videos.sort(key=lambda path: _natural_key(path.name))
    return videos


def _default_frame_extractor(path: Path, frame_number_1based: int) -> bytes:
    png_bytes, _image = extract_frame_as_png_bytes(path, frame_number_1based)
    return png_bytes


def _default_ocr_recognizer(
    png_bytes: bytes,
    *,
    endpoint: str,
    api_key: str,
    secret_key: str,
) -> str:
    client = BaiduOcrClient(api_key, secret_key)
    return client.recognize(png_bytes, endpoint=endpoint)


@dataclass(slots=True)
class WorkerVideoItem:
    id: str
    path: Path
    status: str = "待处理"
    ocr_text: str = ""
    suggested_title: str = ""
    new_name: str = ""
    error: str = ""
    preview_data_url: str = ""

    @property
    def file_name(self) -> str:
        return self.path.name


class DesktopWorker:
    def __init__(
        self,
        *,
        config_path: Path,
        emit: Callable[[dict[str, object]], None],
        frame_extractor: Callable[[Path, int], bytes] | None = None,
        ocr_recognizer: Callable[..., str] | None = None,
        title_extractor: Callable[..., str] | None = None,
    ) -> None:
        self._config_path = config_path
        self._emit = emit
        self._frame_extractor = frame_extractor or _default_frame_extractor
        self._ocr_recognizer = ocr_recognizer or _default_ocr_recognizer
        self._title_extractor = title_extractor or extract_title_sentence

        self._config = load_non_secret_config(self._config_path)
        self._items: list[WorkerVideoItem] = []
        self._items_by_id: dict[str, WorkerVideoItem] = {}
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._task_thread: threading.Thread | None = None

    def handle_request(self, method: str, params: dict[str, object]) -> dict[str, object]:
        handlers: dict[str, Callable[[dict[str, object]], dict[str, object]]] = {
            "load_settings": self._handle_load_settings,
            "save_settings": self._handle_save_settings,
            "scan_videos": self._handle_scan_videos,
            "start_processing": self._handle_start_processing,
            "stop_processing": self._handle_stop_processing,
            "generate_title_from_ocr": self._handle_generate_title,
            "save_ocr_edit": self._handle_save_ocr_edit,
            "save_title_edit": self._handle_save_title_edit,
            "rename_one": self._handle_rename_one,
            "rename_all": self._handle_rename_all,
            "get_items": self._handle_get_items,
            "shutdown": self._handle_shutdown,
        }

        try:
            handler = handlers[method]
        except KeyError as exc:  # pragma: no cover
            raise ValueError(f"Unsupported worker method: {method}") from exc
        return handler(params)

    def wait_for_idle(self, timeout: float | None = None) -> None:
        thread = self._task_thread
        if thread is None:
            return
        thread.join(timeout=timeout)

    def _handle_load_settings(self, _params: dict[str, object]) -> dict[str, object]:
        with self._lock:
            self._config = load_non_secret_config(self._config_path)
            return {"settings": self._serialize_settings(self._config)}

    def _handle_save_settings(self, params: dict[str, object]) -> dict[str, object]:
        settings = self._normalize_settings(self._as_dict(params.get("settings")))
        with self._lock:
            self._config = settings
            self._remember_recent_dir(settings.input_dir)
            save_non_secret_config(self._config_path, self._config)
            return {"settings": self._serialize_settings(self._config)}

    def _handle_scan_videos(self, params: dict[str, object]) -> dict[str, object]:
        directory = self._get_str(params, "directory")
        include_subdirs = self._get_bool(params, "include_subdirs", "includeSubdirs")
        root_dir = Path(directory)
        videos = scan_videos(root_dir, include_subdirs=include_subdirs)

        with self._lock:
            self._items = [
                WorkerVideoItem(id=uuid.uuid4().hex, path=path)
                for path in videos
            ]
            self._items_by_id = {item.id: item for item in self._items}

        self._emit_log(f"扫描完成，共发现 {len(videos)} 条视频。")
        return {"items": [self._serialize_item(item) for item in self._items]}

    def _handle_start_processing(self, params: dict[str, object]) -> dict[str, object]:
        self._ensure_not_busy()
        secrets = self._normalize_secrets(self._as_dict(params.get("secrets")))
        settings = self._normalize_settings(self._as_dict(params.get("settings"))) if params.get("settings") else None
        if settings is not None:
            with self._lock:
                self._config = settings

        self._stop_event.clear()
        self._task_thread = threading.Thread(
            target=self._run_processing,
            args=(secrets,),
            daemon=True,
        )
        self._task_thread.start()
        self._emit_log("开始处理…")
        return {"started": True}

    def _handle_stop_processing(self, _params: dict[str, object]) -> dict[str, object]:
        self._stop_event.set()
        self._emit_log("已请求停止（将在当前文件处理完后停止）。")
        return {"stopping": True}

    def _handle_generate_title(self, params: dict[str, object]) -> dict[str, object]:
        self._ensure_not_busy()
        item = self._get_item(self._get_str(params, "id"))
        secrets = self._normalize_secrets(self._as_dict(params.get("secrets")))
        if "ocrText" in params or "ocr_text" in params:
            item.ocr_text = self._get_str(params, "ocr_text", "ocrText")
        if not item.ocr_text.strip():
            raise ValueError("OCR 文本为空：请先编辑/粘贴识别结果。")

        item.status = "DeepSeek…"
        item.error = ""
        self._emit_item_status(item)

        title = self._title_extractor(
            api_key=secrets["deepseekApiKey"],
            base_url=self._config.deepseek_base_url,
            model=self._config.deepseek_model,
            ocr_text=item.ocr_text,
            system_prompt=self._config.deepseek_system_prompt,
            user_prompt_template=self._config.deepseek_user_prompt_template,
        )

        item.suggested_title = title
        item.new_name = self._compute_target_path(item).name
        item.status = "待重命名"
        item.error = ""
        self._emit_item_title(item)
        self._emit_item_status(item)
        self._emit_log(f"已生成标题：{item.file_name}")
        return {"item": self._serialize_item(item)}

    def _handle_save_ocr_edit(self, params: dict[str, object]) -> dict[str, object]:
        item = self._get_item(self._get_str(params, "id"))
        item.ocr_text = self._get_str(params, "text")
        item.error = ""
        item.status = "已编辑"
        self._emit_log(f"已保存 OCR 编辑：{item.file_name}")
        return {"item": self._serialize_item(item)}

    def _handle_save_title_edit(self, params: dict[str, object]) -> dict[str, object]:
        item = self._get_item(self._get_str(params, "id"))
        item.suggested_title = self._get_str(params, "title")
        item.error = ""
        item.status = "已编辑"
        item.new_name = self._compute_target_path(item).name if item.suggested_title.strip() else ""
        self._emit_log(f"已保存标题：{item.file_name}")
        return {"item": self._serialize_item(item)}

    def _handle_rename_one(self, params: dict[str, object]) -> dict[str, object]:
        self._ensure_not_busy()
        item = self._get_item(self._get_str(params, "id"))
        if "title" in params or "suggestedTitle" in params or "suggested_title" in params:
            item.suggested_title = self._get_str(params, "suggested_title", "suggestedTitle", "title")
        if not item.suggested_title.strip():
            raise ValueError("标题为空：请先编辑标题或点击“用 OCR 生成标题”。")

        target = self._compute_target_path(item)
        item.new_name = target.name

        if self._config.dry_run:
            item.status = "预览"
            item.error = ""
            self._emit_log(f"[预览] {item.file_name} -> {target.name}")
            return {"item": self._serialize_item(item)}

        old_path = item.path
        if target == old_path:
            item.status = "完成"
            item.error = ""
            self._emit_log(f"[完成] {old_path.name}（无需重命名）")
            return {"item": self._serialize_item(item)}

        item.status = "重命名…"
        old_name = item.file_name
        old_path.rename(target)
        item.path = target
        item.status = "完成"
        item.error = ""
        self._emit_log(f"[完成] {target.name}")
        self._emit_item_renamed(item, old_path=old_path, old_file_name=old_name)
        return {"item": self._serialize_item(item)}

    def _handle_rename_all(self, params: dict[str, object]) -> dict[str, object]:
        self._ensure_not_busy()
        settings = self._normalize_settings(self._as_dict(params.get("settings"))) if params.get("settings") else None
        if settings is not None:
            with self._lock:
                self._config = settings

        self._stop_event.clear()
        self._task_thread = threading.Thread(
            target=self._run_rename_all,
            daemon=True,
        )
        self._task_thread.start()
        self._emit_log("开始重命名全部…")
        return {"started": True}

    def _handle_get_items(self, _params: dict[str, object]) -> dict[str, object]:
        return {"items": [self._serialize_item(item) for item in self._items]}

    def _handle_shutdown(self, _params: dict[str, object]) -> dict[str, object]:
        self._stop_event.set()
        return {"shutdown": True}

    def _run_processing(self, secrets: dict[str, str]) -> None:
        total = len(self._items)
        for index, item in enumerate(list(self._items)):
            if self._stop_event.is_set():
                break

            try:
                item.status = "读取帧…"
                item.error = ""
                self._emit_item_status(item)

                png_bytes = self._frame_extractor(item.path, self._config.frame_number_1based)
                item.preview_data_url = self._to_preview_data_url(png_bytes)
                self._emit_item_preview(item)

                item.status = "OCR…"
                self._emit_item_status(item)
                item.ocr_text = self._ocr_recognizer(
                    png_bytes,
                    endpoint=self._config.baidu_ocr_mode,
                    api_key=secrets["baiduApiKey"],
                    secret_key=secrets["baiduSecretKey"],
                )
                self._emit_item_ocr(item)

                item.status = "DeepSeek…"
                self._emit_item_status(item)
                item.suggested_title = self._title_extractor(
                    api_key=secrets["deepseekApiKey"],
                    base_url=self._config.deepseek_base_url,
                    model=self._config.deepseek_model,
                    ocr_text=item.ocr_text,
                    system_prompt=self._config.deepseek_system_prompt,
                    user_prompt_template=self._config.deepseek_user_prompt_template,
                )
                target = self._compute_target_path(item)
                item.new_name = target.name
                self._emit_item_title(item)

                if not self._config.dry_run and target != item.path:
                    old_path = item.path
                    old_name = item.file_name
                    item.status = "重命名…"
                    self._emit_item_status(item)
                    old_path.rename(target)
                    item.path = target
                    self._emit_item_renamed(item, old_path=old_path, old_file_name=old_name)

                item.status = "完成"
                item.error = ""
                self._emit_item_status(item)
            except Exception as exc:
                item.status = "失败"
                item.error = self._format_error(exc)
                self._emit_error(item)
            finally:
                self._emit_progress(index + 1, total)

        self._emit({"event": "done", "message": "处理结束。"})

    def _run_rename_all(self) -> None:
        total = len(self._items)
        for index, item in enumerate(list(self._items)):
            if self._stop_event.is_set():
                break

            title = item.suggested_title.strip() or "未识别"
            item.suggested_title = title
            try:
                target = self._compute_target_path(item)
                item.new_name = target.name
                self._emit_item_title(item)
                if self._config.dry_run:
                    item.status = "预览"
                    item.error = ""
                    self._emit_item_status(item)
                else:
                    if target != item.path:
                        old_path = item.path
                        old_name = item.file_name
                        item.status = "重命名…"
                        self._emit_item_status(item)
                        old_path.rename(target)
                        item.path = target
                        self._emit_item_renamed(item, old_path=old_path, old_file_name=old_name)
                    item.status = "完成"
                    item.error = ""
                    self._emit_item_status(item)
            except Exception as exc:
                item.status = "失败"
                item.error = self._format_error(exc)
                self._emit_error(item)
            finally:
                self._emit_progress(index + 1, total)

        self._emit({"event": "done", "message": "重命名结束。"})

    def _get_item(self, item_id: str) -> WorkerVideoItem:
        try:
            return self._items_by_id[item_id]
        except KeyError as exc:
            raise ValueError("目标记录不存在") from exc

    def _ensure_not_busy(self) -> None:
        if self._task_thread and self._task_thread.is_alive():
            raise RuntimeError("批处理正在运行中，请先停止当前任务。")

    def _compute_target_path(self, item: WorkerVideoItem) -> Path:
        index = self._config.start_index + self._items.index(item)
        target = build_target_path(
            item.path,
            index=index,
            index_padding=self._config.index_padding,
            title=item.suggested_title,
        )
        return pick_non_conflicting_path(target, ignore_path=item.path)

    def _remember_recent_dir(self, directory: str) -> None:
        directory = (directory or "").strip()
        if not directory:
            return
        existing = [entry for entry in self._config.recent_dirs if entry != directory]
        self._config.recent_dirs = [directory, *existing][:10]

    def _serialize_settings(self, config: AppConfig) -> dict[str, object]:
        return {
            "inputDir": config.input_dir,
            "includeSubdirs": config.include_subdirs,
            "frameNumber": config.frame_number_1based,
            "startIndex": config.start_index,
            "indexPadding": config.index_padding,
            "dryRun": config.dry_run,
            "ocrMode": config.baidu_ocr_mode,
            "deepseekBaseUrl": config.deepseek_base_url,
            "deepseekModel": config.deepseek_model,
            "deepseekSystemPrompt": config.deepseek_system_prompt,
            "deepseekUserPromptTemplate": config.deepseek_user_prompt_template,
            "recentDirs": list(config.recent_dirs),
        }

    def _serialize_item(self, item: WorkerVideoItem) -> dict[str, object]:
        return {
            "id": item.id,
            "fullPath": str(item.path),
            "fileName": item.file_name,
            "status": item.status,
            "ocrText": item.ocr_text,
            "suggestedTitle": item.suggested_title,
            "newName": item.new_name,
            "error": item.error,
            "previewDataUrl": item.preview_data_url,
        }

    def _emit_log(self, message: str) -> None:
        self._emit({"event": "log", "message": message})

    def _emit_item_preview(self, item: WorkerVideoItem) -> None:
        self._emit(
            {
                "event": "item_preview",
                "id": item.id,
                "previewDataUrl": item.preview_data_url,
            }
        )

    def _emit_item_ocr(self, item: WorkerVideoItem) -> None:
        self._emit({"event": "item_ocr", "id": item.id, "ocrText": item.ocr_text})

    def _emit_item_title(self, item: WorkerVideoItem) -> None:
        self._emit(
            {
                "event": "item_title",
                "id": item.id,
                "suggestedTitle": item.suggested_title,
                "newName": item.new_name,
            }
        )

    def _emit_item_status(self, item: WorkerVideoItem) -> None:
        self._emit(
            {
                "event": "item_status",
                "id": item.id,
                "status": item.status,
                "error": item.error,
            }
        )

    def _emit_item_renamed(self, item: WorkerVideoItem, *, old_path: Path, old_file_name: str) -> None:
        self._emit(
            {
                "event": "item_renamed",
                "id": item.id,
                "oldFullPath": str(old_path),
                "oldFileName": old_file_name,
                "fullPath": str(item.path),
                "fileName": item.file_name,
                "newName": item.new_name,
            }
        )

    def _emit_error(self, item: WorkerVideoItem) -> None:
        self._emit(
            {
                "event": "error",
                "id": item.id,
                "fileName": item.file_name,
                "fullPath": str(item.path),
                "message": item.error,
            }
        )

    def _emit_progress(self, current: int, total: int) -> None:
        self._emit({"event": "progress", "current": current, "total": total})

    def _normalize_settings(self, values: dict[str, object]) -> AppConfig:
        config = load_non_secret_config(self._config_path)
        config.input_dir = self._get_str(values, "input_dir", "inputDir") or config.input_dir
        config.include_subdirs = self._get_bool(values, "include_subdirs", "includeSubdirs", default=config.include_subdirs)
        config.frame_number_1based = self._get_int(values, "frame_number_1based", "frameNumber", default=config.frame_number_1based)
        config.start_index = self._get_int(values, "start_index", "startIndex", default=config.start_index)
        config.index_padding = self._get_int(values, "index_padding", "indexPadding", default=config.index_padding)
        config.dry_run = self._get_bool(values, "dry_run", "dryRun", default=config.dry_run)
        config.baidu_ocr_mode = self._get_str(values, "baidu_ocr_mode", "ocrMode") or config.baidu_ocr_mode
        config.deepseek_base_url = self._get_str(values, "deepseek_base_url", "deepseekBaseUrl") or config.deepseek_base_url
        config.deepseek_model = self._get_str(values, "deepseek_model", "deepseekModel") or config.deepseek_model
        config.deepseek_system_prompt = self._get_str(values, "deepseek_system_prompt", "deepseekSystemPrompt") or config.deepseek_system_prompt
        config.deepseek_user_prompt_template = (
            self._get_str(values, "deepseek_user_prompt_template", "deepseekUserPromptTemplate")
            or config.deepseek_user_prompt_template
        )
        recent_dirs = values.get("recent_dirs", values.get("recentDirs"))
        if isinstance(recent_dirs, list):
            config.recent_dirs = [str(entry) for entry in recent_dirs if str(entry).strip()]
        return config

    def _normalize_secrets(self, values: dict[str, object]) -> dict[str, str]:
        baidu_api_key = self._get_str(values, "baidu_api_key", "baiduApiKey")
        baidu_secret_key = self._get_str(values, "baidu_secret_key", "baiduSecretKey")
        deepseek_api_key = self._get_str(values, "deepseek_api_key", "deepseekApiKey")
        if not baidu_api_key or not baidu_secret_key:
            raise ValueError("缺少百度 OCR 的 API Key / Secret Key。")
        if not deepseek_api_key:
            raise ValueError("缺少 DeepSeek API Key。")
        return {
            "baiduApiKey": baidu_api_key,
            "baiduSecretKey": baidu_secret_key,
            "deepseekApiKey": deepseek_api_key,
        }

    def _to_preview_data_url(self, png_bytes: bytes) -> str:
        return f"data:image/png;base64,{base64.b64encode(png_bytes).decode('ascii')}"

    def _format_error(self, error: Exception) -> str:
        message = str(error).strip()
        if message:
            return message
        return traceback.format_exc().strip()

    def _as_dict(self, value: object) -> dict[str, object]:
        if isinstance(value, dict):
            return value
        return {}

    def _get_str(self, values: dict[str, object], *keys: str) -> str:
        for key in keys:
            value = values.get(key)
            if value is None:
                continue
            return str(value).strip()
        return ""

    def _get_int(self, values: dict[str, object], *keys: str, default: int) -> int:
        for key in keys:
            value = values.get(key)
            if value is None or value == "":
                continue
            return int(value)
        return int(default)

    def _get_bool(self, values: dict[str, object], *keys: str, default: bool = False) -> bool:
        for key in keys:
            value = values.get(key)
            if value is None:
                continue
            return bool(value)
        return bool(default)


class WorkerProtocol:
    def __init__(self) -> None:
        self._write_lock = threading.Lock()

    def emit(self, event: dict[str, object]) -> None:
        with self._write_lock:
            print(json.dumps({"type": "event", **event}, ensure_ascii=False), flush=True)

    def respond(self, request_id: str, ok: bool, payload: dict[str, object] | None = None, error: str | None = None) -> None:
        body: dict[str, object] = {"type": "response", "requestId": request_id, "ok": ok}
        if payload is not None:
            body["payload"] = payload
        if error is not None:
            body["error"] = error
        with self._write_lock:
            print(json.dumps(body, ensure_ascii=False), flush=True)
