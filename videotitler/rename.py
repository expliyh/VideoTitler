from __future__ import annotations

import re
from dataclasses import dataclass
from collections.abc import Iterable
from pathlib import Path


_WINDOWS_INVALID_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1F]')
_VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}


@dataclass(frozen=True, slots=True)
class VideoIndexSuggestion:
    suggested_index: int
    candidate_indexes: list[int]
    suggested_index_padding: int
    is_auto_increment: bool


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


def _parse_leading_index(file_name: str) -> tuple[int, int] | None:
    stem = Path(file_name).stem
    match = re.match(r"^(\d+)(?:[-_\s.]|$)", stem)
    if not match:
        return None
    raw_index = match.group(1)
    value = int(raw_index)
    return (value, len(raw_index)) if value > 0 else None


def suggest_video_index_from_names(
    file_names: Iterable[str],
    *,
    default_index_padding: int = 3,
) -> VideoIndexSuggestion:
    parsed_indexes = [
        parsed
        for file_name in file_names
        if Path(file_name).suffix.lower() in _VIDEO_EXTS
        for parsed in [_parse_leading_index(file_name)]
        if parsed is not None
    ]
    index_padding = max(
        1,
        max((width for _index, width in parsed_indexes), default=int(default_index_padding or 1)),
    )
    indexes = sorted({index for index, _width in parsed_indexes})
    if not indexes:
        return VideoIndexSuggestion(
            suggested_index=1,
            candidate_indexes=[],
            suggested_index_padding=index_padding,
            is_auto_increment=True,
        )

    used = set(indexes)
    max_index = indexes[-1]
    candidate_indexes = [
        index
        for index in range(1, max_index)
        if index not in used
    ]
    if candidate_indexes:
        return VideoIndexSuggestion(
            suggested_index=candidate_indexes[0],
            candidate_indexes=candidate_indexes,
            suggested_index_padding=index_padding,
            is_auto_increment=False,
        )

    return VideoIndexSuggestion(
        suggested_index=max_index + 1,
        candidate_indexes=[],
        suggested_index_padding=index_padding,
        is_auto_increment=True,
    )


def suggest_video_index_for_path(
    video_path: Path,
    *,
    default_index_padding: int = 3,
) -> VideoIndexSuggestion:
    path = Path(video_path)
    sibling_names = [
        child.name
        for child in path.parent.iterdir()
        if child.is_file() and child.name != path.name
    ]
    return suggest_video_index_from_names(
        sibling_names,
        default_index_padding=default_index_padding,
    )


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
