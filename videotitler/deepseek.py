from __future__ import annotations

import re
import time

import requests


class DeepSeekError(RuntimeError):
    pass


def _first_non_empty_line(text: str) -> str:
    for line in (text or "").splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def extract_title_sentence(
    *,
    api_key: str,
    base_url: str,
    model: str,
    ocr_text: str,
    system_prompt: str,
    user_prompt_template: str,
    timeout_s: int = 60,
    retries: int = 2,
) -> str:
    api_key = api_key.strip()
    if not api_key:
        raise DeepSeekError("缺少 DeepSeek API Key。")

    if not ocr_text.strip():
        raise DeepSeekError("OCR 文本为空。")

    base_url = (base_url or "").strip().rstrip("/")
    if not base_url:
        base_url = "https://api.deepseek.com/v1"

    url = f"{base_url}/chat/completions"

    system_prompt = (system_prompt or "").strip()
    user_prompt_template = (user_prompt_template or "").strip()
    if not system_prompt:
        raise DeepSeekError("DeepSeek system prompt 为空。")
    if not user_prompt_template:
        raise DeepSeekError("DeepSeek user prompt 模板为空。")

    try:
        user_prompt = user_prompt_template.format(ocr_text=ocr_text)
    except Exception:
        # If template formatting fails, fall back to appending OCR.
        user_prompt = user_prompt_template.rstrip() + "\n\nOCR 文本：\n" + ocr_text

    retries = max(1, int(retries))
    last_exc: Exception | None = None
    for attempt in range(retries):
        try:
            response = requests.post(
                url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": (model or "deepseek-chat"),
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    "temperature": 0.2,
                    "max_tokens": 80,
                },
                timeout=timeout_s,
            )
            response.raise_for_status()
            payload = response.json()
            break
        except requests.RequestException as exc:
            last_exc = exc
            if attempt + 1 >= retries:
                raise DeepSeekError(f"DeepSeek 请求失败（网络超时/连接）：{exc}") from exc
            time.sleep(1.0 * (2**attempt))
        except ValueError as exc:
            raise DeepSeekError("DeepSeek 返回不是 JSON。") from exc
    else:  # pragma: no cover
        raise DeepSeekError(f"DeepSeek 请求失败：{last_exc}")

    try:
        content = payload["choices"][0]["message"]["content"]
    except Exception as exc:
        raise DeepSeekError(f"DeepSeek 返回格式异常：{payload!r}") from exc

    title = _first_non_empty_line(content)

    # Light cleanup in case the model returns quotes/prefixes.
    title = re.sub(r'^[\"“”\'\s]+|[\"“”\'\s]+$', "", title).strip()
    title = re.sub(r"^(标题|title)[:：\s]+", "", title, flags=re.IGNORECASE).strip()
    return title
