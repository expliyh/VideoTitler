from __future__ import annotations

import re
import threading
import traceback
from dataclasses import asdict, dataclass
from pathlib import Path
from queue import Empty, Queue

try:
    import ttkbootstrap as ttk
    from ttkbootstrap.constants import BOTH, END, LEFT, RIGHT, X, Y
except Exception:  # pragma: no cover
    ttk = None  # type: ignore
    BOTH = END = LEFT = RIGHT = X = Y = None  # type: ignore

try:
    from PIL import Image, ImageTk
except Exception:  # pragma: no cover
    Image = None  # type: ignore
    ImageTk = None  # type: ignore

try:
    from tkinter.scrolledtext import ScrolledText
except Exception:  # pragma: no cover
    ScrolledText = None  # type: ignore

from videotitler.baidu_ocr import BaiduOcrClient, BaiduOcrError
from videotitler.config import AppConfig, default_config_path, load_config, save_config
from videotitler.deepseek import DeepSeekError, extract_title_sentence
from videotitler.rename import build_target_path, pick_non_conflicting_path
from videotitler.video import VideoFrameError, extract_frame_as_png_bytes


VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}


@dataclass(slots=True)
class VideoRow:
    path: Path
    status: str = "待处理"
    ocr_text: str = ""
    preview_image: object | None = None
    title: str = ""
    new_name: str = ""
    error: str = ""


def _require_ui_deps() -> None:
    if ttk is None:
        raise RuntimeError("缺少依赖 ttkbootstrap。请先安装 requirements.txt。")
    if Image is None or ImageTk is None:
        raise RuntimeError("缺少依赖 pillow。请先安装 requirements.txt。")
    if ScrolledText is None:
        raise RuntimeError("缺少 tkinter 组件 scrolledtext。")


def _scan_videos(root_dir: Path, *, include_subdirs: bool) -> list[Path]:
    if include_subdirs:
        candidates = [p for p in root_dir.rglob("*") if p.is_file()]
    else:
        candidates = [p for p in root_dir.iterdir() if p.is_file()]

    videos = [p for p in candidates if p.suffix.lower() in VIDEO_EXTS]

    def natural_key(name: str) -> list[object]:
        parts = re.split(r"(\\d+)", name)
        key: list[object] = []
        for part in parts:
            if part.isdigit():
                key.append(int(part))
            else:
                key.append(part.lower())
        return key

    videos.sort(key=lambda p: natural_key(p.name))
    return videos


class VideoTitlerApp:
    def __init__(self) -> None:
        _require_ui_deps()

        self._config_path = default_config_path()
        self._config = load_config(self._config_path)

        self._rows: list[VideoRow] = []
        self._queue: "Queue[tuple[str, object]]" = Queue()
        self._stop_event = threading.Event()
        self._worker: threading.Thread | None = None

        self._img_cache: ImageTk.PhotoImage | None = None

        self._build_ui()
        self._load_config_to_ui()

        self._root.after(100, self._drain_queue)

    def _build_ui(self) -> None:
        self._root = ttk.Window(themename="flatly")
        self._root.title("VideoTitler - OCR + DeepSeek 自动命名")
        self._root.geometry("1180x720")
        self._root.minsize(1024, 640)

        top = ttk.Frame(self._root, padding=10)
        top.pack(fill=X)

        self._dir_var = ttk.StringVar(value="")
        ttk.Label(top, text="视频目录").pack(side=LEFT)
        self._dir_entry = ttk.Entry(top, textvariable=self._dir_var)
        self._dir_entry.pack(side=LEFT, fill=X, expand=True, padx=(8, 8))
        ttk.Button(top, text="浏览…", command=self._pick_dir, bootstyle="secondary").pack(
            side=LEFT
        )
        ttk.Button(top, text="扫描", command=self._scan, bootstyle="info").pack(
            side=LEFT, padx=(8, 0)
        )

        options = ttk.Frame(self._root, padding=(10, 0, 10, 10))
        options.pack(fill=X)

        self._frame_var = ttk.IntVar(value=1)
        self._start_index_var = ttk.IntVar(value=1)
        self._padding_var = ttk.IntVar(value=3)
        self._include_subdirs_var = ttk.BooleanVar(value=False)
        self._dry_run_var = ttk.BooleanVar(value=False)
        self._ocr_mode_var = ttk.StringVar(value="accurate_basic")

        ttk.Label(options, text="第 X 帧(从1开始)").pack(side=LEFT)
        ttk.Spinbox(options, from_=1, to=1_000_000, width=8, textvariable=self._frame_var).pack(
            side=LEFT, padx=(8, 16)
        )

        ttk.Label(options, text="起始序号").pack(side=LEFT)
        ttk.Spinbox(options, from_=1, to=1_000_000, width=6, textvariable=self._start_index_var).pack(
            side=LEFT, padx=(8, 16)
        )

        ttk.Label(options, text="序号补零").pack(side=LEFT)
        ttk.Spinbox(options, from_=1, to=8, width=4, textvariable=self._padding_var).pack(
            side=LEFT, padx=(8, 16)
        )

        ttk.Checkbutton(options, text="包含子目录", variable=self._include_subdirs_var).pack(
            side=LEFT, padx=(0, 16)
        )
        ttk.Checkbutton(options, text="仅预览(不改名)", variable=self._dry_run_var).pack(
            side=LEFT
        )

        ttk.Label(options, text="OCR").pack(side=LEFT, padx=(16, 0))
        self._ocr_mode_combo = ttk.Combobox(
            options,
            textvariable=self._ocr_mode_var,
            width=12,
            values=("accurate_basic", "general_basic"),
            state="readonly",
        )
        self._ocr_mode_combo.pack(side=LEFT, padx=(8, 0))

        actions = ttk.Frame(self._root, padding=(10, 0, 10, 10))
        actions.pack(fill=X)

        ttk.Button(actions, text="开始处理", command=self._start, bootstyle="success").pack(
            side=LEFT
        )
        ttk.Button(actions, text="重命名全部", command=self._rename_all, bootstyle="primary").pack(
            side=LEFT, padx=(8, 0)
        )
        ttk.Button(actions, text="停止", command=self._stop, bootstyle="warning").pack(
            side=LEFT, padx=(8, 0)
        )
        ttk.Button(actions, text="打开目录", command=self._open_dir, bootstyle="secondary").pack(
            side=LEFT, padx=(8, 0)
        )

        self._progress = ttk.Progressbar(actions, mode="determinate")
        self._progress.pack(side=LEFT, fill=X, expand=True, padx=(16, 0))

        Panedwindow = getattr(ttk, "Panedwindow", None) or getattr(ttk, "PanedWindow", None)
        if Panedwindow is None:  # pragma: no cover
            raise RuntimeError("当前 ttkbootstrap 版本缺少 Panedwindow 组件。")
        paned = Panedwindow(self._root, orient="horizontal")
        paned.pack(fill=BOTH, expand=True, padx=10, pady=(0, 10))

        left = ttk.Frame(paned)
        right = ttk.Frame(paned)
        paned.add(left, weight=3)
        paned.add(right, weight=2)

        self._tree = ttk.Treeview(
            left,
            columns=("file", "status", "title", "new_name"),
            show="headings",
            height=18,
        )
        self._tree.heading("file", text="文件")
        self._tree.heading("status", text="状态")
        self._tree.heading("title", text="提取标题")
        self._tree.heading("new_name", text="新文件名")

        self._tree.column("file", width=280, anchor="w")
        self._tree.column("status", width=90, anchor="w")
        self._tree.column("title", width=260, anchor="w")
        self._tree.column("new_name", width=360, anchor="w")

        self._tree.pack(fill=BOTH, expand=True, side=LEFT)
        self._tree.bind("<<TreeviewSelect>>", self._on_select)

        yscroll = ttk.Scrollbar(left, orient="vertical", command=self._tree.yview)
        self._tree.configure(yscrollcommand=yscroll.set)
        yscroll.pack(side=RIGHT, fill=Y)

        notebook = ttk.Notebook(right)
        notebook.pack(fill=BOTH, expand=True)

        tab_preview = ttk.Frame(notebook, padding=10)
        tab_ocr = ttk.Frame(notebook, padding=10)
        tab_keys = ttk.Frame(notebook, padding=10)
        notebook.add(tab_preview, text="预览")
        notebook.add(tab_ocr, text="OCR/日志")
        notebook.add(tab_keys, text="密钥/设置")

        self._preview_label = ttk.Label(tab_preview, text="(选择一条视频查看预览帧)", anchor="center")
        self._preview_label.pack(fill=BOTH, expand=True)

        ocr_toolbar = ttk.Frame(tab_ocr)
        ocr_toolbar.pack(fill=X, pady=(0, 8))

        ttk.Button(
            ocr_toolbar,
            text="保存 OCR 编辑",
            command=self._save_ocr_edit,
            bootstyle="secondary",
        ).pack(side=LEFT)
        ttk.Button(
            ocr_toolbar,
            text="用 OCR 生成标题",
            command=self._generate_title_for_selected,
            bootstyle="info",
        ).pack(side=LEFT, padx=(8, 0))
        ttk.Button(
            ocr_toolbar,
            text="单条重命名",
            command=self._rename_selected,
            bootstyle="success",
        ).pack(side=LEFT, padx=(8, 0))

        title_bar = ttk.Frame(tab_ocr)
        title_bar.pack(fill=X, pady=(0, 8))
        ttk.Label(title_bar, text="标题").pack(side=LEFT)
        self._title_var = ttk.StringVar(value="")
        self._title_entry = ttk.Entry(title_bar, textvariable=self._title_var)
        self._title_entry.pack(side=LEFT, fill=X, expand=True, padx=(8, 8))
        ttk.Button(
            title_bar,
            text="保存标题",
            command=self._save_title_edit,
            bootstyle="secondary",
        ).pack(side=LEFT)

        self._error_var = ttk.StringVar(value="")
        self._error_label = ttk.Label(tab_ocr, textvariable=self._error_var, bootstyle="danger")
        self._error_label.pack(fill=X, pady=(0, 8))

        self._ocr_text = ScrolledText(tab_ocr, height=12, wrap="word")
        self._ocr_text.pack(fill=BOTH, expand=True)

        self._log_text = ScrolledText(tab_ocr, height=10, wrap="word")
        self._log_text.pack(fill=BOTH, expand=True, pady=(10, 0))

        # Keys / Settings tab
        self._baidu_api_key_var = ttk.StringVar(value="")
        self._baidu_secret_key_var = ttk.StringVar(value="")
        self._deepseek_api_key_var = ttk.StringVar(value="")
        self._deepseek_base_url_var = ttk.StringVar(value="https://api.deepseek.com/v1")
        self._deepseek_model_var = ttk.StringVar(value="deepseek-chat")
        self._save_keys_var = ttk.BooleanVar(value=False)

        grid = ttk.Frame(tab_keys)
        grid.pack(fill=BOTH, expand=True)

        def add_row(row: int, label: str, var: ttk.StringVar, *, show: str | None = None) -> None:
            ttk.Label(grid, text=label).grid(row=row, column=0, sticky="w", pady=6)
            entry = ttk.Entry(grid, textvariable=var, show=show) if show else ttk.Entry(grid, textvariable=var)
            entry.grid(row=row, column=1, sticky="ew", pady=6, padx=(10, 0))

        add_row(0, "百度 API Key", self._baidu_api_key_var)
        add_row(1, "百度 Secret Key", self._baidu_secret_key_var, show="*")
        add_row(2, "DeepSeek API Key", self._deepseek_api_key_var, show="*")
        add_row(3, "DeepSeek Base URL", self._deepseek_base_url_var)
        add_row(4, "DeepSeek Model", self._deepseek_model_var)

        grid.columnconfigure(1, weight=1)

        ttk.Checkbutton(grid, text="保存密钥到本地 config.json", variable=self._save_keys_var).grid(
            row=5, column=0, columnspan=2, sticky="w", pady=(8, 10)
        )
        ttk.Button(grid, text="保存设置", command=self._save_settings, bootstyle="secondary").grid(
            row=6, column=0, sticky="w"
        )

        ttk.Separator(grid).grid(row=7, column=0, columnspan=2, sticky="ew", pady=(14, 10))
        ttk.Label(grid, text="DeepSeek System Prompt").grid(row=8, column=0, sticky="nw", pady=6)
        self._ds_system_prompt_text = ScrolledText(grid, height=6, wrap="word")
        self._ds_system_prompt_text.grid(row=8, column=1, sticky="nsew", pady=6, padx=(10, 0))

        ttk.Label(grid, text="DeepSeek User Prompt 模板（支持 {ocr_text}）").grid(
            row=9, column=0, sticky="nw", pady=6
        )
        self._ds_user_prompt_text = ScrolledText(grid, height=8, wrap="word")
        self._ds_user_prompt_text.grid(row=9, column=1, sticky="nsew", pady=6, padx=(10, 0))

        ttk.Button(grid, text="重置为默认 Prompt", command=self._reset_prompts, bootstyle="secondary").grid(
            row=10, column=0, sticky="w", pady=(6, 0)
        )

        grid.rowconfigure(8, weight=1)
        grid.rowconfigure(9, weight=2)

    def _append_log(self, message: str) -> None:
        self._log_text.insert(END, message.rstrip() + "\n")
        self._log_text.see(END)

    def _set_error(self, message: str) -> None:
        self._error_var.set((message or "").strip())

    def _set_ocr_text(self, text: str) -> None:
        self._ocr_text.delete("1.0", END)
        self._ocr_text.insert(END, text or "")
        self._ocr_text.see("1.0")

    def _get_selected_row(self) -> VideoRow | None:
        selection = self._tree.selection()
        if not selection:
            return None
        path = Path(selection[0])
        for row in self._rows:
            if row.path == path:
                return row
        return None

    def _compute_index_for_row(self, row: VideoRow) -> int:
        cfg = self._read_ui_to_config()
        try:
            offset = self._rows.index(row)
        except ValueError:
            offset = 0
        return int(cfg.start_index or 1) + offset

    def _update_new_name_preview(self, row: VideoRow) -> None:
        cfg = self._read_ui_to_config()
        if not row.title.strip():
            row.new_name = ""
            return
        target = build_target_path(
            row.path,
            index=self._compute_index_for_row(row),
            index_padding=cfg.index_padding,
            title=row.title,
        )
        row.new_name = target.name

    def _pick_dir(self) -> None:
        from tkinter import filedialog

        selected = filedialog.askdirectory(initialdir=self._dir_var.get() or None)
        if selected:
            self._dir_var.set(selected)

    def _open_dir(self) -> None:
        import os

        path = self._dir_var.get().strip()
        if not path:
            return
        try:
            os.startfile(path)  # type: ignore[attr-defined]
        except Exception as exc:
            self._append_log(f"打开目录失败：{exc}")

    def _save_ocr_edit(self) -> None:
        row = self._get_selected_row()
        if row is None:
            self._append_log("请先在左侧列表选择一条视频。")
            return

        text = self._ocr_text.get("1.0", END).strip()
        row.ocr_text = text
        if row.error:
            row.error = ""
        row.status = "已编辑"
        self._set_error("")
        self._append_log(f"已保存 OCR 编辑：{row.path.name}")
        self._update_row(row.path, status=row.status, ocr_text=row.ocr_text, error=row.error)

    def _save_title_edit(self) -> None:
        row = self._get_selected_row()
        if row is None:
            self._append_log("请先在左侧列表选择一条视频。")
            return

        title = (self._title_var.get() or "").strip()
        row.title = title
        self._update_new_name_preview(row)
        if row.error:
            row.error = ""
        row.status = "已编辑"
        self._set_error("")
        self._append_log(f"已保存标题：{row.path.name}")
        self._update_row(row.path, status=row.status, title=row.title, new_name=row.new_name, error=row.error)

    def _generate_title_for_selected(self) -> None:
        if self._worker and self._worker.is_alive():
            self._append_log("批处理正在运行中，请先停止后再单条生成。")
            return

        row = self._get_selected_row()
        if row is None:
            self._append_log("请先在左侧列表选择一条视频。")
            return

        cfg = self._read_ui_to_config()
        if not cfg.deepseek_api_key:
            self._append_log("请先在“密钥/设置”中填写 DeepSeek API Key。")
            return

        ocr_text = self._ocr_text.get("1.0", END).strip()
        if not ocr_text:
            self._append_log("OCR 文本为空：请先编辑/粘贴识别结果。")
            return

        row.ocr_text = ocr_text
        row.status = "DeepSeek…"
        row.error = ""
        self._set_error("")
        self._update_row(row.path, status=row.status, ocr_text=row.ocr_text, error=row.error)

        src_path = row.path
        index = self._compute_index_for_row(row)
        padding = cfg.index_padding
        system_prompt = cfg.deepseek_system_prompt
        user_prompt_template = cfg.deepseek_user_prompt_template
        base_url = cfg.deepseek_base_url
        model = cfg.deepseek_model
        api_key = cfg.deepseek_api_key

        def worker() -> None:
            try:
                title = extract_title_sentence(
                    api_key=api_key,
                    base_url=base_url,
                    model=model,
                    ocr_text=ocr_text,
                    system_prompt=system_prompt,
                    user_prompt_template=user_prompt_template,
                )
                target = build_target_path(
                    src_path,
                    index=index,
                    index_padding=padding,
                    title=title,
                )
                target = pick_non_conflicting_path(target)
                self._queue.put(("title", (src_path, title, target.name)))
                self._queue.put(("status", (src_path, "待重命名")))
            except (DeepSeekError, OSError) as exc:
                self._queue.put(("error", (src_path, str(exc))))
            except Exception:
                self._queue.put(("error", (src_path, traceback.format_exc())))

        threading.Thread(target=worker, daemon=True).start()

    def _rename_selected(self) -> None:
        if self._worker and self._worker.is_alive():
            self._append_log("批处理正在运行中，请先停止后再单条重命名。")
            return

        row = self._get_selected_row()
        if row is None:
            self._append_log("请先在左侧列表选择一条视频。")
            return

        cfg = self._read_ui_to_config()
        title = (self._title_var.get() or "").strip()
        if not title:
            self._append_log("标题为空：请先编辑标题或点击“用 OCR 生成标题”。")
            return

        old_path = row.path
        row.title = title
        index = self._compute_index_for_row(row)
        target = build_target_path(old_path, index=index, index_padding=cfg.index_padding, title=title)
        target = pick_non_conflicting_path(target)
        row.new_name = target.name

        if cfg.dry_run:
            row.status = "预览"
            self._append_log(f"[预览] {old_path.name} -> {target.name}")
            self._update_row(old_path, status=row.status, title=row.title, new_name=row.new_name)
            return

        try:
            self._update_row(old_path, status="重命名…", title=row.title, new_name=row.new_name)
            old_path.rename(target)
            self._queue.put(("renamed", (old_path, target)))
            row.path = target
            row.status = "完成"
            row.error = ""
            self._set_error("")
            self._append_log(f"[完成] {target.name}")
            self._queue.put(("status", (row.path, row.status)))
        except OSError as exc:
            row.error = str(exc)
            row.status = "失败"
            self._set_error(row.error)
            self._append_log(f"[失败] {old_path.name}: {row.error}")
            self._update_row(old_path, status=row.status, error=row.error)

    def _load_config_to_ui(self) -> None:
        cfg = self._config
        self._dir_var.set(cfg.input_dir)
        self._include_subdirs_var.set(bool(cfg.include_subdirs))
        self._frame_var.set(int(cfg.frame_number_1based or 1))
        self._start_index_var.set(int(cfg.start_index or 1))
        self._padding_var.set(int(cfg.index_padding or 3))
        self._dry_run_var.set(bool(cfg.dry_run))
        self._ocr_mode_var.set((cfg.baidu_ocr_mode or "accurate_basic").strip())

        self._deepseek_base_url_var.set(cfg.deepseek_base_url or "https://api.deepseek.com/v1")
        self._deepseek_model_var.set(cfg.deepseek_model or "deepseek-chat")
        self._save_keys_var.set(bool(cfg.save_keys_locally))
        self._ds_system_prompt_text.delete("1.0", END)
        self._ds_system_prompt_text.insert(END, cfg.deepseek_system_prompt or "")
        self._ds_user_prompt_text.delete("1.0", END)
        self._ds_user_prompt_text.insert(END, cfg.deepseek_user_prompt_template or "")
        if cfg.save_keys_locally:
            self._baidu_api_key_var.set(cfg.baidu_api_key)
            self._baidu_secret_key_var.set(cfg.baidu_secret_key)
            self._deepseek_api_key_var.set(cfg.deepseek_api_key)

    def _read_ui_to_config(self) -> AppConfig:
        cfg = self._config
        cfg.input_dir = self._dir_var.get().strip()
        cfg.include_subdirs = bool(self._include_subdirs_var.get())
        cfg.frame_number_1based = int(self._frame_var.get() or 1)
        cfg.start_index = int(self._start_index_var.get() or 1)
        cfg.index_padding = int(self._padding_var.get() or 3)
        cfg.dry_run = bool(self._dry_run_var.get())
        cfg.baidu_ocr_mode = (self._ocr_mode_var.get() or "accurate_basic").strip()

        cfg.baidu_api_key = self._baidu_api_key_var.get().strip()
        cfg.baidu_secret_key = self._baidu_secret_key_var.get().strip()
        cfg.deepseek_api_key = self._deepseek_api_key_var.get().strip()
        cfg.deepseek_base_url = self._deepseek_base_url_var.get().strip() or "https://api.deepseek.com/v1"
        cfg.deepseek_model = self._deepseek_model_var.get().strip() or "deepseek-chat"
        cfg.save_keys_locally = bool(self._save_keys_var.get())
        cfg.deepseek_system_prompt = self._ds_system_prompt_text.get("1.0", END).strip()
        cfg.deepseek_user_prompt_template = self._ds_user_prompt_text.get("1.0", END).strip()

        # Recent dirs
        if cfg.input_dir:
            existing = [d for d in cfg.recent_dirs if d != cfg.input_dir]
            cfg.recent_dirs = [cfg.input_dir, *existing][:10]
        return cfg

    def _reset_prompts(self) -> None:
        cfg = AppConfig()
        self._ds_system_prompt_text.delete("1.0", END)
        self._ds_system_prompt_text.insert(END, cfg.deepseek_system_prompt)
        self._ds_user_prompt_text.delete("1.0", END)
        self._ds_user_prompt_text.insert(END, cfg.deepseek_user_prompt_template)
        self._append_log("已重置 Prompt（记得点“保存设置”）。")

    def _save_settings(self) -> None:
        cfg = self._read_ui_to_config()
        if not cfg.baidu_api_key or not cfg.baidu_secret_key:
            self._append_log("请先在“密钥/设置”中填写百度 API Key / Secret Key。")
            return
        if not cfg.deepseek_api_key:
            self._append_log("请先在“密钥/设置”中填写 DeepSeek API Key。")
            return
        if cfg.frame_number_1based < 1:
            self._append_log("第 X 帧必须 >= 1。")
            return
        if cfg.baidu_ocr_mode not in {"accurate_basic", "general_basic"}:
            self._append_log("OCR 模式无效，请选择 accurate_basic 或 general_basic。")
            return
        save_config(self._config_path, cfg)
        self._append_log(f"已保存设置：{self._config_path}")

    def _snapshot_config(self) -> AppConfig:
        cfg = self._read_ui_to_config()
        save_config(self._config_path, cfg)
        return AppConfig(**asdict(cfg))

    def _scan(self) -> None:
        cfg = self._read_ui_to_config()
        save_config(self._config_path, cfg)

        root_dir = Path(cfg.input_dir)
        if not root_dir.exists():
            self._append_log("目录不存在。")
            return

        videos = _scan_videos(root_dir, include_subdirs=cfg.include_subdirs)
        self._rows = [VideoRow(path=p) for p in videos]

        for item in self._tree.get_children():
            self._tree.delete(item)

        for row in self._rows:
            self._tree.insert(
                "",
                END,
                iid=str(row.path),
                values=(row.path.name, row.status, row.title, row.new_name),
            )

        self._progress.configure(value=0, maximum=max(1, len(self._rows)))
        self._append_log(f"扫描到 {len(self._rows)} 个视频。")

    def _start(self) -> None:
        if self._worker and self._worker.is_alive():
            self._append_log("正在处理中…")
            return

        if not self._rows:
            self._append_log("请先扫描视频。")
            return

        cfg = self._snapshot_config()

        self._stop_event.clear()
        self._progress.configure(value=0, maximum=max(1, len(self._rows)))
        self._worker = threading.Thread(target=self._run_worker, args=(cfg,), daemon=True)
        self._worker.start()
        self._append_log("开始处理…")

    def _stop(self) -> None:
        self._stop_event.set()
        self._append_log("已请求停止（将在当前文件处理完后停止）。")

    def _rename_all(self) -> None:
        if self._worker and self._worker.is_alive():
            self._append_log("正在处理中…")
            return

        if not self._rows:
            self._append_log("请先扫描视频。")
            return

        cfg = self._snapshot_config()
        self._stop_event.clear()
        self._progress.configure(value=0, maximum=max(1, len(self._rows)))
        self._worker = threading.Thread(target=self._run_rename_all, args=(cfg,), daemon=True)
        self._worker.start()
        self._append_log("开始重命名全部…")

    def _run_rename_all(self, cfg: AppConfig) -> None:
        start_index = int(cfg.start_index or 1)
        index_padding = int(cfg.index_padding or 3)

        for offset, row in enumerate(self._rows):
            if self._stop_event.is_set():
                break

            fixed_index = start_index + offset
            title = (row.title or "").strip() or "未识别"

            old_path = row.path
            try:
                target = build_target_path(
                    old_path,
                    index=fixed_index,
                    index_padding=index_padding,
                    title=title,
                )
                target = pick_non_conflicting_path(target)
                self._queue.put(("title", (old_path, title, target.name)))

                if cfg.dry_run:
                    self._queue.put(("status", (old_path, "预览")))
                else:
                    old_path.rename(target)
                    self._queue.put(("renamed", (old_path, target)))
                    self._queue.put(("status", (target, "完成")))
            except OSError as exc:
                self._queue.put(("error", (old_path, f"重命名失败：{exc}")))
            except Exception:
                self._queue.put(("error", (old_path, f"重命名异常：\n{traceback.format_exc()}")))
            finally:
                self._queue.put(("progress", offset + 1))

        self._queue.put(("done", "重命名结束。"))

    def _run_worker(self, cfg: AppConfig) -> None:
        ocr_client = BaiduOcrClient(cfg.baidu_api_key, cfg.baidu_secret_key)

        for offset, row in enumerate(self._rows):
            if self._stop_event.is_set():
                break

            fixed_index = int(cfg.start_index or 1) + offset
            stage = "读取帧"
            self._queue.put(("status", (row.path, "读取帧…")))
            try:
                stage = "读取帧"
                png_bytes, image = extract_frame_as_png_bytes(row.path, cfg.frame_number_1based)
                self._queue.put(("preview", (row.path, image)))

                stage = "OCR"
                self._queue.put(("status", (row.path, "OCR…")))
                ocr_text = ocr_client.recognize(png_bytes, endpoint=cfg.baidu_ocr_mode)
                self._queue.put(("ocr", (row.path, ocr_text)))

                stage = "DeepSeek"
                self._queue.put(("status", (row.path, "DeepSeek…")))
                title = extract_title_sentence(
                    api_key=cfg.deepseek_api_key,
                    base_url=cfg.deepseek_base_url,
                    model=cfg.deepseek_model,
                    ocr_text=ocr_text,
                    system_prompt=cfg.deepseek_system_prompt,
                    user_prompt_template=cfg.deepseek_user_prompt_template,
                )

                target = build_target_path(
                    row.path,
                    index=fixed_index,
                    index_padding=cfg.index_padding,
                    title=title,
                )
                target = pick_non_conflicting_path(target)

                new_name = target.name
                self._queue.put(("title", (row.path, title, new_name)))

                if not cfg.dry_run:
                    stage = "重命名"
                    old_path = row.path
                    old_path.rename(target)
                    self._queue.put(("renamed", (old_path, target)))

                self._queue.put(("status", ((target if not cfg.dry_run else row.path), "完成")))
            except (VideoFrameError, BaiduOcrError, DeepSeekError, OSError) as exc:
                self._queue.put(("error", (row.path, f"{stage}失败：{exc}")))
            except Exception:
                self._queue.put(("error", (row.path, f"{stage}异常：\n{traceback.format_exc()}")))
            finally:
                self._queue.put(("progress", offset + 1))

        self._queue.put(("done", "处理结束。"))

    def _drain_queue(self) -> None:
        while True:
            try:
                kind, payload = self._queue.get_nowait()
            except Empty:
                break
            self._handle_event(kind, payload)
        self._root.after(120, self._drain_queue)

    def _handle_event(self, kind: str, payload: object) -> None:
        if kind == "progress":
            value = int(payload or 0)
            self._progress.configure(value=value)
            return

        if kind == "done":
            if isinstance(payload, str) and payload.strip():
                self._append_log(payload.strip())
            else:
                self._append_log("处理结束。")
            return

        if kind == "preview":
            path, image = payload  # type: ignore[misc]
            self._update_row(path, preview_image=image)
            self._set_preview_image(path, image)
            return

        if kind == "ocr":
            path, ocr_text = payload  # type: ignore[misc]
            self._update_row(path, ocr_text=str(ocr_text))
            return

        if kind == "title":
            path, title, new_name = payload  # type: ignore[misc]
            self._update_row(path, title=str(title), new_name=str(new_name))
            return

        if kind == "renamed":
            old_path, new_path = payload  # type: ignore[misc]
            self._on_renamed(old_path, new_path)
            return

        if kind == "status":
            path, status = payload  # type: ignore[misc]
            self._update_row(path, status=str(status))
            return

        if kind == "error":
            path, error = payload  # type: ignore[misc]
            self._update_row(path, status="失败", error=str(error))
            self._append_log(f"[失败] {Path(path).name}: {error}")
            return

    def _on_renamed(self, old_path: Path, new_path: Path) -> None:
        old_iid = str(old_path)
        new_iid = str(new_path)

        for row in self._rows:
            if row.path == old_path:
                row.path = new_path
                break

        if not self._tree.exists(old_iid):
            return

        values = list(self._tree.item(old_iid, "values"))
        if values:
            values[0] = new_path.name
        self._tree.delete(old_iid)
        self._tree.insert("", END, iid=new_iid, values=values)

    def _update_row(
        self,
        path: Path,
        *,
        status: str | None = None,
        ocr_text: str | None = None,
        preview_image: object | None = None,
        title: str | None = None,
        new_name: str | None = None,
        error: str | None = None,
    ) -> None:
        for row in self._rows:
            if row.path == path:
                if status is not None:
                    row.status = status
                if ocr_text is not None:
                    row.ocr_text = ocr_text
                if preview_image is not None:
                    row.preview_image = preview_image
                if title is not None:
                    row.title = title
                if new_name is not None:
                    row.new_name = new_name
                if error is not None:
                    row.error = error

                iid = str(row.path)
                if self._tree.exists(iid):
                    self._tree.item(iid, values=(row.path.name, row.status, row.title, row.new_name))

                # If currently selected, refresh details
                selected = self._tree.selection()
                if selected and selected[0] == iid:
                    self._sync_selected_details(row)
                return

    def _on_select(self, _event: object) -> None:
        row = self._get_selected_row()
        if row is None:
            return
        self._sync_selected_details(row)

    def _set_preview_image(self, path: Path, image: Image.Image) -> None:
        selection = self._tree.selection()
        if selection and selection[0] != str(path):
            return

        max_w = max(480, self._preview_label.winfo_width() - 20)
        max_h = max(320, self._preview_label.winfo_height() - 20)

        preview = image.copy()
        preview.thumbnail((max_w, max_h))
        photo = ImageTk.PhotoImage(preview)
        self._img_cache = photo
        self._preview_label.configure(image=photo, text="")

    def _sync_selected_details(self, row: VideoRow) -> None:
        self._set_ocr_text(row.ocr_text)
        self._title_var.set(row.title or "")
        self._set_error(row.error)
        if row.preview_image is not None:
            self._set_preview_image(row.path, row.preview_image)  # type: ignore[arg-type]
        else:
            self._img_cache = None
            self._preview_label.configure(image="", text="(暂无预览帧：请先处理或保持选中等待处理)")


def run_app() -> None:
    app = VideoTitlerApp()
    app._root.mainloop()
