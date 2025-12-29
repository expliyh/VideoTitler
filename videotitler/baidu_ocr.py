from __future__ import annotations

import base64
import io
import time
from dataclasses import dataclass

import requests


class BaiduOcrError(RuntimeError):
    pass


_OCR_GENERAL_BASIC_URL = "https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic"
_OCR_ACCURATE_BASIC_URL = "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic"


def _maybe_compress_image_for_ocr(image_bytes: bytes) -> bytes:
    # Large PNGs (e.g. 4K frames) can cause slow uploads and timeouts.
    # If image is bigger than ~2MB, downscale and encode as JPEG to reduce payload.
    if len(image_bytes) <= 2_000_000:
        return image_bytes

    try:
        from PIL import Image
    except Exception:
        return image_bytes

    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
        if image.mode not in {"RGB", "L"}:
            image = image.convert("RGB")

        max_side = 1600
        if max(image.size) > max_side:
            image.thumbnail((max_side, max_side))

        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=88, optimize=True)
        jpeg_bytes = buffer.getvalue()
        if jpeg_bytes and len(jpeg_bytes) < len(image_bytes):
            return jpeg_bytes
    except Exception:
        return image_bytes

    return image_bytes


@dataclass(slots=True)
class _TokenCache:
    token: str = ""
    expires_at_epoch: float = 0.0


class BaiduOcrClient:
    def __init__(
        self,
        api_key: str,
        secret_key: str,
        *,
        timeout_s: int = 60,
        retries: int = 2,
    ) -> None:
        self._api_key = api_key.strip()
        self._secret_key = secret_key.strip()
        self._timeout_s = max(5, int(timeout_s))
        self._retries = max(1, int(retries))
        self._token_cache = _TokenCache()

    def _get_access_token(self) -> str:
        now = time.time()
        if self._token_cache.token and now < self._token_cache.expires_at_epoch:
            return self._token_cache.token

        if not self._api_key or not self._secret_key:
            raise BaiduOcrError("缺少百度 OCR 的 API Key / Secret Key。")

        url = "https://aip.baidubce.com/oauth/2.0/token"
        last_exc: Exception | None = None
        for attempt in range(self._retries):
            try:
                response = requests.post(
                    url,
                    data={
                        "grant_type": "client_credentials",
                        "client_id": self._api_key,
                        "client_secret": self._secret_key,
                    },
                    timeout=self._timeout_s,
                )
                response.raise_for_status()
                payload = response.json()
                break
            except requests.RequestException as exc:
                last_exc = exc
                if attempt + 1 >= self._retries:
                    raise BaiduOcrError(f"获取 access_token 失败（网络超时/连接）：{exc}") from exc
                time.sleep(1.0 * (2**attempt))
            except ValueError as exc:
                raise BaiduOcrError("获取 access_token 失败：返回不是 JSON。") from exc
        else:  # pragma: no cover
            raise BaiduOcrError(f"获取 access_token 失败：{last_exc}")

        token = payload.get("access_token")
        expires_in = int(payload.get("expires_in", 0))
        if not token:
            raise BaiduOcrError(f"获取 access_token 失败：{payload!r}")

        # Refresh 60s earlier.
        self._token_cache.token = token
        self._token_cache.expires_at_epoch = now + max(0, expires_in - 60)
        return token

    def general_basic(
        self,
        image_bytes: bytes,
        *,
        language_type: str = "CHN_ENG",
        detect_direction: bool = True,
    ) -> str:
        return self.recognize(
            image_bytes,
            endpoint="general_basic",
            language_type=language_type,
            detect_direction=detect_direction,
        )

    def accurate_basic(
        self,
        image_bytes: bytes,
        *,
        language_type: str = "CHN_ENG",
        detect_direction: bool = True,
    ) -> str:
        return self.recognize(
            image_bytes,
            endpoint="accurate_basic",
            language_type=language_type,
            detect_direction=detect_direction,
        )

    def recognize(
        self,
        image_bytes: bytes,
        *,
        endpoint: str = "accurate_basic",
        language_type: str = "CHN_ENG",
        detect_direction: bool = True,
    ) -> str:
        """
        endpoint: "accurate_basic"（高精度）或 "general_basic"（通用）
        """
        token = self._get_access_token()
        endpoint = (endpoint or "accurate_basic").strip().lower()
        if endpoint == "accurate_basic":
            url = _OCR_ACCURATE_BASIC_URL
        elif endpoint == "general_basic":
            url = _OCR_GENERAL_BASIC_URL
        else:
            raise BaiduOcrError(f"未知 OCR endpoint：{endpoint}")

        image_bytes = _maybe_compress_image_for_ocr(image_bytes)
        image_b64 = base64.b64encode(image_bytes).decode("ascii")

        last_exc: Exception | None = None
        for attempt in range(self._retries):
            try:
                response = requests.post(
                    url,
                    params={"access_token": token},
                    data={
                        "image": image_b64,
                        "language_type": language_type,
                        "detect_direction": "true" if detect_direction else "false",
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    timeout=self._timeout_s,
                )
                response.raise_for_status()
                payload = response.json()
                break
            except requests.RequestException as exc:
                last_exc = exc
                if attempt + 1 >= self._retries:
                    raise BaiduOcrError(f"OCR 请求失败（网络超时/连接）：{exc}") from exc
                time.sleep(1.0 * (2**attempt))
            except ValueError as exc:
                raise BaiduOcrError("OCR 失败：返回不是 JSON。") from exc
        else:  # pragma: no cover
            raise BaiduOcrError(f"OCR 请求失败：{last_exc}")

        if "error_code" in payload:
            raise BaiduOcrError(f"OCR 失败：{payload}")

        words = []
        for item in payload.get("words_result", []) or []:
            value = (item or {}).get("words", "")
            if value:
                words.append(value)

        return "\n".join(words).strip()
