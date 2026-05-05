from __future__ import annotations

import re
import time
from dataclasses import dataclass

import requests


class DeepSeekError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class DeepSeekTitleResult:
    title: str
    raw_text: str


def _first_non_empty_line(text: str) -> str:
    for line in (text or "").splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def _deepseek_message_parts(message: dict[str, object]) -> tuple[str, str, str]:
    content = str(message.get("content") or "").strip()
    reasoning_content = str(message.get("reasoning_content") or "").strip()

    if content and reasoning_content:
        return content, reasoning_content, f"[content]\n{content}\n\n[reasoning_content]\n{reasoning_content}"
    if content:
        return content, reasoning_content, content
    return content, reasoning_content, reasoning_content


def extract_title_result(
    *,
    api_key: str,
    base_url: str,
    model: str,
    ocr_text: str,
    system_prompt: str,
    user_prompt_template: str,
    timeout_s: int = 60,
    retries: int = 2,
    thinking_enabled: bool = True,
) -> DeepSeekTitleResult:
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
            request_body: dict[str, object] = {
                "model": (model or "deepseek-v4-pro"),
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "thinking": {"type": "enabled" if thinking_enabled else "disabled"},
                "max_tokens": 8192 if thinking_enabled else 80,
            }
            if not thinking_enabled:
                request_body["temperature"] = 0.2

            response = requests.post(
                url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=request_body,
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
        message = payload["choices"][0]["message"]
    except Exception as exc:
        raise DeepSeekError(f"DeepSeek 返回格式异常：{payload!r}") from exc

    if not isinstance(message, dict):
        raise DeepSeekError(f"DeepSeek message format is invalid: {payload!r}")

    content, _reasoning_content, raw_text = _deepseek_message_parts(message)
    if not content.strip():
        raise DeepSeekError(f"DeepSeek returned empty final content. Full response: {raw_text or payload!r}")
    title = _first_non_empty_line(content)

    # Light cleanup in case the model returns quotes/prefixes.
    title = re.sub(r'^[\"“”\'\s]+|[\"“”\'\s]+$', "", title).strip()
    title = re.sub(r"^(标题|title)[:：\s]+", "", title, flags=re.IGNORECASE).strip()
    return DeepSeekTitleResult(title=title, raw_text=raw_text)


def extract_title_sentence(**kwargs: object) -> str:
    return extract_title_result(**kwargs).title
