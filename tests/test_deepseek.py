from __future__ import annotations

import unittest
from unittest.mock import patch

from videotitler.deepseek import DeepSeekError, DeepSeekTitleResult, extract_title_result


class _FakeResponse:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, object]:
        return self._payload


def _payload(content: str, reasoning_content: str = "") -> dict[str, object]:
    return {
        "choices": [
            {
                "message": {
                    "content": content,
                    "reasoning_content": reasoning_content,
                }
            }
        ]
    }


class DeepSeekTests(unittest.TestCase):
    def test_extract_title_result_sends_thinking_enabled_by_default(self) -> None:
        with patch("videotitler.deepseek.requests.post", return_value=_FakeResponse(_payload("Final Title"))) as post:
            result = extract_title_result(
                api_key="key",
                base_url="https://api.deepseek.com/v1",
                model="deepseek-chat",
                ocr_text="OCR TEXT",
                system_prompt="system",
                user_prompt_template="user {ocr_text}",
            )

        self.assertIsInstance(result, DeepSeekTitleResult)
        self.assertEqual(result.title, "Final Title")
        request_json = post.call_args.kwargs["json"]
        self.assertEqual(request_json["thinking"], {"type": "enabled"})
        self.assertNotIn("temperature", request_json)
        self.assertGreaterEqual(request_json["max_tokens"], 8192)

    def test_extract_title_result_can_disable_thinking_mode(self) -> None:
        with patch("videotitler.deepseek.requests.post", return_value=_FakeResponse(_payload("Final Title"))) as post:
            extract_title_result(
                api_key="key",
                base_url="https://api.deepseek.com/v1",
                model="deepseek-chat",
                ocr_text="OCR TEXT",
                system_prompt="system",
                user_prompt_template="user {ocr_text}",
                thinking_enabled=False,
            )

        request_json = post.call_args.kwargs["json"]
        self.assertEqual(request_json["thinking"], {"type": "disabled"})
        self.assertEqual(request_json["temperature"], 0.2)
        self.assertEqual(request_json["max_tokens"], 80)

    def test_extract_title_result_keeps_reasoning_as_raw_text_not_title(self) -> None:
        with patch(
            "videotitler.deepseek.requests.post",
            return_value=_FakeResponse(_payload("Final Title", "thinking trace")),
        ):
            result = extract_title_result(
                api_key="key",
                base_url="https://api.deepseek.com/v1",
                model="deepseek-chat",
                ocr_text="OCR TEXT",
                system_prompt="system",
                user_prompt_template="user {ocr_text}",
            )

        self.assertEqual(result.title, "Final Title")
        self.assertIn("[content]", result.raw_text)
        self.assertIn("Final Title", result.raw_text)
        self.assertIn("[reasoning_content]", result.raw_text)
        self.assertIn("thinking trace", result.raw_text)

    def test_extract_title_result_rejects_reasoning_without_final_content(self) -> None:
        with patch(
            "videotitler.deepseek.requests.post",
            return_value=_FakeResponse(_payload("", "thinking only")),
        ):
            with self.assertRaisesRegex(DeepSeekError, "empty final content"):
                extract_title_result(
                    api_key="key",
                    base_url="https://api.deepseek.com/v1",
                    model="deepseek-chat",
                    ocr_text="OCR TEXT",
                    system_prompt="system",
                    user_prompt_template="user {ocr_text}",
                )


if __name__ == "__main__":
    unittest.main()
