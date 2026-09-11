from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass(slots=True)
class AppConfig:
    input_dir: str = ""
    include_subdirs: bool = False

    # Recognition pipeline: "ocr" keeps the legacy Baidu OCR flow;
    # "vision" sends the extracted frame directly to DeepSeek.
    recognition_mode: str = "ocr"

    frame_number_1based: int = 1

    start_index: int = 1
    index_padding: int = 3
    dry_run: bool = False

    # Credentials (optionally persisted)
    baidu_api_key: str = ""
    baidu_secret_key: str = ""
    baidu_ocr_mode: str = "accurate_basic"
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com/v1"
    deepseek_model: str = "deepseek-v4-pro"
    deepseek_vision_model: str = "deepseek-v4-flash"
    deepseek_thinking_enabled: bool = True
    deepseek_system_prompt: str = (
        "你是标题提炼助手。你会从杂乱的 OCR 文本中提取一个适合作为短视频标题的中文短句。"
        "标题是文本中的原文，具有以下特征\n"
        "- 通常是指引玩家动作的句子或短语，不应是比较宏大的语句\n"
        "- 如果某一行的开头是。，那么他大概率是\n"
        "只输出标题本身，不要解释，不要加引号，不要编号，不要换行，修复文本括号不配对的问题，不要删除括号。"
    )
    deepseek_user_prompt_template: str = (
        "从以下 OCR 文本中提取一个适合作为标题的短句（尽量 ≤ 20 个汉字，必要时可包含数字/英文字母）。\n\n"
        "OCR 文本：\n{ocr_text}\n\n"
        "输出要求：只输出标题一行。"
    )
    deepseek_vision_system_prompt: str = (
        "你是游戏任务界面视觉理解助手。请只根据用户消息中的游戏截图实际可见内容进行识别，"
        "不要把界面图标、装饰图案或不确定的符号臆测成文字，也不要补全截图中不可见的信息。"
        "请严格只输出一个 JSON 对象，不要 Markdown、解释或额外文字。JSON 必须包含字符串字段："
        "chapter_title（章标题）、section_title（节标题）、task_summary（任务简述）、"
        "task_details（详细任务内容）、suggested_title（适合视频文件名的简短标题）。"
        "如果某项在画面中不存在或无法确认，填写空字符串；suggested_title 尽量不超过 20 个汉字。"
    )
    deepseek_vision_user_prompt_template: str = (
        "请观察这张游戏任务界面截图，识别当前正在进行的任务信息。"
        "分别提取章标题、节标题、任务简述和详细任务内容，并生成一个适合用于视频文件名的简短建议标题。"
        "只返回约定的 JSON 字段，不要输出识别过程。"
    )

    ui_language: str = "system"

    # UX
    save_keys_locally: bool = False
    recent_dirs: list[str] = field(default_factory=list)


_NON_SECRET_FIELDS = {
    "input_dir",
    "include_subdirs",
    "recognition_mode",
    "frame_number_1based",
    "start_index",
    "index_padding",
    "dry_run",
    "baidu_ocr_mode",
    "deepseek_base_url",
    "deepseek_model",
    "deepseek_vision_model",
    "deepseek_thinking_enabled",
    "deepseek_system_prompt",
    "deepseek_user_prompt_template",
    "deepseek_vision_system_prompt",
    "deepseek_vision_user_prompt_template",
    "ui_language",
    "recent_dirs",
}


def default_config_path() -> Path:
    return Path.cwd() / "config.json"


def load_config(path: Path) -> AppConfig:
    if not path.exists():
        return AppConfig()

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return AppConfig()

    config = AppConfig()
    for key, value in data.items():
        if hasattr(config, key):
            setattr(config, key, value)
    return config


def save_config(path: Path, config: AppConfig) -> None:
    data = asdict(config)
    if not config.save_keys_locally:
        data["baidu_api_key"] = ""
        data["baidu_secret_key"] = ""
        data["deepseek_api_key"] = ""

    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_non_secret_config(path: Path) -> AppConfig:
    config = load_config(path)
    config.baidu_api_key = ""
    config.baidu_secret_key = ""
    config.deepseek_api_key = ""
    config.save_keys_locally = False
    return config


def save_non_secret_config(path: Path, config: AppConfig) -> None:
    data = {
        key: value
        for key, value in asdict(config).items()
        if key in _NON_SECRET_FIELDS
    }

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
