from __future__ import annotations

import unittest
from unittest.mock import patch

from videotitler.deepseek import DeepSeekError, DeepSeekTitleResult, DeepSeekVisionResult, extract_title_result, extract_vision_result


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
    def test_extract_vision_result_sends_png_content_and_parses_json(self) -> None:
        content = '{"chapter_title":"第一章","section_title":"序幕","task_summary":"找到入口","task_details":"前往城门并与守卫对话","suggested_title":"前往城门"}'
        with patch(
            "videotitler.deepseek.requests.post",
            return_value=_FakeResponse(_payload(content, "visual reasoning")),
        ) as post:
            result = extract_vision_result(
                api_key="key",
                base_url="https://api.deepseek.com/v1",
                model="deepseek-v4-flash",
                image_bytes=b"png-bytes",
                system_prompt="vision system",
                user_prompt_template="vision user",
            )

        self.assertIsInstance(result, DeepSeekVisionResult)
        self.assertEqual(result.chapter_title, "第一章")
        self.assertEqual(result.task_details, "前往城门并与守卫对话")
        self.assertEqual(result.suggested_title, "前往城门")
        self.assertIn("visual reasoning", result.raw_text)
        request_json = post.call_args.kwargs["json"]
        self.assertEqual(request_json["model"], "deepseek-v4-flash")
        user_content = request_json["messages"][1]["content"]
        self.assertEqual(user_content[0], {"type": "text", "text": "vision user"})
        self.assertEqual(user_content[1]["type"], "image_url")
        self.assertEqual(user_content[1]["image_url"]["url"], "data:image/png;base64," + "cG5nLWJ5dGVz")

    def test_extract_vision_result_accepts_code_fence_and_falls_back_to_summary(self) -> None:
        content = '```json\n{"chapter_title":"","section_title":"","task_summary":"护送商队","task_details":"沿路清理敌人","suggested_title":""}\n```'
        with patch("videotitler.deepseek.requests.post", return_value=_FakeResponse(_payload(content))):
            result = extract_vision_result(
                api_key="key",
                base_url="https://api.deepseek.com/v1",
                model="deepseek-v4-flash",
                image_bytes=b"png",
                system_prompt="system",
                user_prompt_template="user",
            )

        self.assertEqual(result.suggested_title, "护送商队")

    def test_extract_vision_result_rejects_malformed_or_incomplete_json(self) -> None:
        for content, expected in (
            ("not json", "不是有效 JSON"),
            ('{"chapter_title":"only"}', "缺少字段"),
        ):
            with self.subTest(content=content), patch("videotitler.deepseek.requests.post", return_value=_FakeResponse(_payload(content))):
                with self.assertRaisesRegex(DeepSeekError, expected):
                    extract_vision_result(
                        api_key="key",
                        base_url="https://api.deepseek.com/v1",
                        model="deepseek-v4-flash",
                        image_bytes=b"png",
                        system_prompt="system",
                        user_prompt_template="user",
                    )

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
