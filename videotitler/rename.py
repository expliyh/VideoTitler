from __future__ import annotations

import re
from pathlib import Path


_WINDOWS_INVALID_CHARS_RE = re.compile(r"[<>:\"/\\\\|?*\\x00-\\x1F]")


def sanitize_filename_component(text: str, *, fallback: str = "标题", max_len: int = 80) -> str:
    cleaned = (text or "").replace("\u200b", " ").strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = _WINDOWS_INVALID_CHARS_RE.sub(" ", cleaned)
    cleaned = cleaned.strip(" .")
    cleaned = cleaned.strip()

    if not cleaned:
        cleaned = fallback

    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len].rstrip()
    return cleaned


def build_target_path(
    src_path: Path,
    *,
    index: int,
    index_padding: int,
    title: str,
) -> Path:
    safe_title = sanitize_filename_component(title)
    prefix = str(index).zfill(max(1, int(index_padding)))
    filename = f"{prefix}-{safe_title}{src_path.suffix}"
    return src_path.with_name(filename)


def pick_non_conflicting_path(target_path: Path, *, ignore_path: Path | None = None) -> Path:
    if ignore_path is not None and target_path == ignore_path:
        return target_path

    if not target_path.exists():
        return target_path

    stem = target_path.stem
    suffix = target_path.suffix
    parent = target_path.parent

    counter = 2
    while True:
        candidate = parent / f"{stem}_{counter}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1
