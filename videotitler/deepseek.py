from __future__ import annotations

import base64
import json
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


@dataclass(frozen=True, slots=True)
class DeepSeekVisionResult:
    chapter_title: str
    section_title: str
    task_summary: str
    task_details: str
    suggested_title: str
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


def _request_completion(
    *,
    url: str,
    api_key: str,
    request_body: dict[str, object],
    timeout_s: int,
    retries: int,
) -> dict[str, object]:
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
                json=request_body,
                timeout=timeout_s,
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise DeepSeekError("DeepSeek 返回格式异常：顶层 JSON 不是对象。")
            return payload
        except requests.RequestException as exc:
            last_exc = exc
            if attempt + 1 >= retries:
                raise DeepSeekError(f"DeepSeek 请求失败（网络超时/连接）：{exc}") from exc
            time.sleep(1.0 * (2**attempt))
        except ValueError as exc:
            raise DeepSeekError("DeepSeek 返回不是 JSON。") from exc

    raise DeepSeekError(f"DeepSeek 请求失败：{last_exc}")


def _message_from_payload(payload: dict[str, object]) -> dict[str, object]:
    try:
        message = payload["choices"][0]["message"]  # type: ignore[index]
    except Exception as exc:
        raise DeepSeekError(f"DeepSeek 返回格式异常：{payload!r}") from exc

    if not isinstance(message, dict):
        raise DeepSeekError(f"DeepSeek message format is invalid: {payload!r}")
    return message


def _parse_json_object(content: str) -> dict[str, object]:
    candidate = (content or "").strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*", "", candidate, flags=re.IGNORECASE)
        candidate = re.sub(r"\s*```$", "", candidate).strip()

    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        parsed = None
        decoder = json.JSONDecoder()
        for start, char in enumerate(candidate):
            if char != "{":
                continue
            try:
                parsed, _end = decoder.raw_decode(candidate[start:])
                break
            except json.JSONDecodeError:
                continue

    if not isinstance(parsed, dict):
        raise DeepSeekError("DeepSeek 视觉结果不是有效 JSON 对象。")
    return parsed


_VISION_FIELDS = (
    "chapter_title",
    "section_title",
    "task_summary",
    "task_details",
    "suggested_title",
)


def _vision_field(payload: dict[str, object], key: str) -> str:
    value = payload.get(key, "")
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    raise DeepSeekError(f"DeepSeek 视觉字段 {key} 必须是字符串或空值。")


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

    payload = _request_completion(
        url=url,
        api_key=api_key,
        request_body=request_body,
        timeout_s=timeout_s,
        retries=retries,
    )
    message = _message_from_payload(payload)

    content, _reasoning_content, raw_text = _deepseek_message_parts(message)
    if not content.strip():
        raise DeepSeekError(f"DeepSeek returned empty final content. Full response: {raw_text or payload!r}")
    title = _first_non_empty_line(content)

    # Light cleanup in case the model returns quotes/prefixes.
    title = re.sub(r'^[\"“”\'\s]+|[\"“”\'\s]+$', "", title).strip()
    title = re.sub(r"^(标题|title)[:：\s]+", "", title, flags=re.IGNORECASE).strip()
    return DeepSeekTitleResult(title=title, raw_text=raw_text)


def extract_vision_result(
    *,
    api_key: str,
    base_url: str,
    model: str,
    image_bytes: bytes,
    system_prompt: str,
    user_prompt_template: str,
    timeout_s: int = 60,
    retries: int = 2,
    thinking_enabled: bool = True,
) -> DeepSeekVisionResult:
    api_key = api_key.strip()
    if not api_key:
        raise DeepSeekError("缺少 DeepSeek API Key。")
    if not image_bytes:
        raise DeepSeekError("视觉图片为空。")
    if len(image_bytes) > 32 * 1024 * 1024:
        raise DeepSeekError("视觉图片超过 32 MiB 内联请求限制，请降低视频帧分辨率。")

    base_url = (base_url or "").strip().rstrip("/")
    if not base_url:
        base_url = "https://api.deepseek.com/v1"
    url = f"{base_url}/chat/completions"

    system_prompt = (system_prompt or "").strip()
    user_prompt_template = (user_prompt_template or "").strip()
    if not system_prompt:
        raise DeepSeekError("DeepSeek 视觉 system prompt 为空。")
    if not user_prompt_template:
        raise DeepSeekError("DeepSeek 视觉 user prompt 模板为空。")

    try:
        user_prompt = user_prompt_template.format()
    except Exception:
        user_prompt = user_prompt_template

    image_data_url = "data:image/png;base64," + base64.b64encode(image_bytes).decode("ascii")
    request_body: dict[str, object] = {
        "model": (model or "deepseek-v4-flash"),
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ],
            },
        ],
        "thinking": {"type": "enabled" if thinking_enabled else "disabled"},
        "max_tokens": 8192 if thinking_enabled else 1024,
    }
    if not thinking_enabled:
        request_body["temperature"] = 0.2

    payload = _request_completion(
        url=url,
        api_key=api_key,
        request_body=request_body,
        timeout_s=timeout_s,
        retries=retries,
    )
    message = _message_from_payload(payload)
    content, _reasoning_content, raw_text = _deepseek_message_parts(message)
    if not content:
        raise DeepSeekError(f"DeepSeek returned empty final content. Full response: {raw_text or payload!r}")

    result_payload = _parse_json_object(content)
    missing = [key for key in _VISION_FIELDS if key not in result_payload]
    if missing:
        raise DeepSeekError(f"DeepSeek 视觉结果缺少字段：{', '.join(missing)}")

    fields = {key: _vision_field(result_payload, key) for key in _VISION_FIELDS}
    suggested_title = fields["suggested_title"] or fields["task_summary"]
    return DeepSeekVisionResult(
        chapter_title=fields["chapter_title"],
        section_title=fields["section_title"],
        task_summary=fields["task_summary"],
        task_details=fields["task_details"],
        suggested_title=suggested_title,
        raw_text=raw_text,
    )


def extract_title_sentence(**kwargs: object) -> str:
    return extract_title_result(**kwargs).title
