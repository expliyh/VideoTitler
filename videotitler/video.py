from __future__ import annotations

import io
import os
import shutil
import subprocess
from pathlib import Path

from PIL import Image


class VideoFrameError(RuntimeError):
    pass


def _safe_which(cmd: str | os.PathLike[str], *, path: str | os.PathLike[str] | None = None) -> str | None:
    # On Windows before Python 3.12, passing PathLike to shutil.which could fail.
    # Always coerce to str to avoid that runtime edge case and the deprecated PathLike overload.
    cmd_str = os.fspath(cmd)
    path_str = os.fspath(path) if path is not None else None
    return shutil.which(cmd_str, path=path_str)


def extract_frame_as_png_bytes(
    video_path: Path,
    frame_number_1based: int,
) -> tuple[bytes, Image.Image]:
    if frame_number_1based < 1:
        raise VideoFrameError("帧序号必须是 >= 1 的整数。")

    ffmpeg = _safe_which("ffmpeg") or _safe_which("ffmpeg.exe")
    if not ffmpeg:
        raise VideoFrameError("未找到 ffmpeg：请先安装 ffmpeg 并加入 PATH。")

    frame_index = frame_number_1based - 1

    def run_extract(args: list[str]) -> bytes:
        try:
            proc = subprocess.run(
                args,
                check=False,
                capture_output=True,
                timeout=60,
            )
        except subprocess.TimeoutExpired as exc:
            raise VideoFrameError("ffmpeg 抽帧超时。") from exc

        if proc.returncode != 0:
            stderr = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
            raise VideoFrameError(f"ffmpeg 抽帧失败：{stderr or '未知错误'}")
        return proc.stdout or b""

    # Use select filter to pick 0-based frame index.
    args = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        str(video_path),
        "-map",
        "0:v:0",
        "-vf",
        f"select=eq(n\\,{frame_index})",
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
    ]
    png_bytes = run_extract(args)
    if not png_bytes:
        # Fallback to last frame (near end) when requested index is out of range.
        args_last = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-sseof",
            "-0.1",
            "-i",
            str(video_path),
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "pipe:1",
        ]
        png_bytes = run_extract(args_last)
        if not png_bytes:
            raise VideoFrameError(f"读取帧失败：{video_path} (frame={frame_number_1based})")

    try:
        image = Image.open(io.BytesIO(png_bytes))
        image.load()
    except Exception as exc:
        raise VideoFrameError("PNG 解码失败（ffmpeg 输出异常）。") from exc

    return png_bytes, image
