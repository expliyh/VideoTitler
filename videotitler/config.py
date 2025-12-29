from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass(slots=True)
class AppConfig:
    input_dir: str = ""
    include_subdirs: bool = False

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
    deepseek_model: str = "deepseek-chat"
    deepseek_system_prompt: str = (
        "你是标题提炼助手。你会从杂乱的 OCR 文本中提取一个适合作为短视频标题的中文短句。"
        "标题是文本中的原文，具有以下特征\n"
        "- 通常是指引玩家动作的句子或短语\n"
        "只输出标题本身，不要解释，不要加引号，不要编号，不要换行，修复文本括号不配对的问题。"
    )
    deepseek_user_prompt_template: str = (
        "从以下 OCR 文本中提取一个适合作为标题的短句（尽量 ≤ 20 个汉字，必要时可包含数字/英文字母）。\n\n"
        "OCR 文本：\n{ocr_text}\n\n"
        "输出要求：只输出标题一行。"
    )

    # UX
    save_keys_locally: bool = False
    recent_dirs: list[str] = field(default_factory=list)


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
