from __future__ import annotations

import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from videotitler.config import AppConfig, load_non_secret_config, save_non_secret_config
from videotitler.desktop_worker import DesktopWorker
from videotitler.rename import suggest_video_index_for_path


class DesktopWorkerTests(unittest.TestCase):
    def test_suggest_video_index_for_path_finds_missing_indexes(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "001-Opening.mp4").write_bytes(b"one")
            (root / "003-Move.mkv").write_bytes(b"three")
            (root / "005-End.webm").write_bytes(b"five")
            target = root / "raw.mp4"
            target.write_bytes(b"raw")

            suggestion = suggest_video_index_for_path(target)

            self.assertEqual(suggestion.suggested_index, 2)
            self.assertEqual(suggestion.candidate_indexes, [2, 4])
            self.assertEqual(suggestion.suggested_index_padding, 3)
            self.assertFalse(suggestion.is_auto_increment)

    def test_suggest_video_index_for_path_follows_existing_padding(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "0001-Opening.mp4").write_bytes(b"one")
            (root / "0003-Move.mkv").write_bytes(b"three")
            target = root / "raw.mp4"
            target.write_bytes(b"raw")

            suggestion = suggest_video_index_for_path(target)

            self.assertEqual(suggestion.suggested_index, 2)
            self.assertEqual(suggestion.suggested_index_padding, 4)

    def test_suggest_video_index_for_path_auto_increments_when_no_gap_exists(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "001-Opening.mp4").write_bytes(b"one")
            (root / "002-Move.mkv").write_bytes(b"two")
            target = root / "raw.mp4"
            target.write_bytes(b"raw")

            suggestion = suggest_video_index_for_path(target)

            self.assertEqual(suggestion.suggested_index, 3)
            self.assertEqual(suggestion.candidate_indexes, [])
            self.assertEqual(suggestion.suggested_index_padding, 3)
            self.assertTrue(suggestion.is_auto_increment)

    def test_save_non_secret_config_omits_secrets(self) -> None:
        with TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "settings.json"
            config = AppConfig(
                input_dir="C:/videos",
                include_subdirs=True,
                frame_number_1based=7,
                start_index=3,
                index_padding=4,
                dry_run=True,
                baidu_api_key="baidu-key",
                baidu_secret_key="baidu-secret",
                deepseek_api_key="deepseek-key",
                deepseek_base_url="https://api.deepseek.com/v1",
                deepseek_model="deepseek-chat",
                deepseek_thinking_enabled=False,
                deepseek_system_prompt="system",
                deepseek_user_prompt_template="user {ocr_text}",
                recent_dirs=["C:/videos", "D:/clips"],
            )

            save_non_secret_config(config_path, config)
            loaded = load_non_secret_config(config_path)

            self.assertEqual(loaded.input_dir, "C:/videos")
            self.assertTrue(loaded.include_subdirs)
            self.assertEqual(loaded.frame_number_1based, 7)
            self.assertEqual(loaded.start_index, 3)
            self.assertEqual(loaded.index_padding, 4)
            self.assertTrue(loaded.dry_run)
            self.assertEqual(loaded.baidu_ocr_mode, "accurate_basic")
            self.assertEqual(loaded.deepseek_base_url, "https://api.deepseek.com/v1")
            self.assertEqual(loaded.deepseek_model, "deepseek-chat")
            self.assertFalse(loaded.deepseek_thinking_enabled)
            self.assertEqual(loaded.deepseek_system_prompt, "system")
            self.assertEqual(loaded.deepseek_user_prompt_template, "user {ocr_text}")
            self.assertEqual(loaded.recent_dirs, ["C:/videos", "D:/clips"])
            self.assertEqual(loaded.baidu_api_key, "")
            self.assertEqual(loaded.baidu_secret_key, "")
            self.assertEqual(loaded.deepseek_api_key, "")

    def test_save_settings_supports_deepseek_thinking_mode(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            worker = self._create_worker(root / "settings.json")

            saved = worker.handle_request(
                "save_settings",
                {
                    "settings": {
                        "input_dir": str(root),
                        "deepseekThinkingEnabled": False,
                    }
                },
            )

            self.assertFalse(saved["settings"]["deepseekThinkingEnabled"])
            loaded = worker.handle_request("load_settings", {})
            self.assertFalse(loaded["settings"]["deepseekThinkingEnabled"])


    def test_save_settings_supports_ui_language_and_falls_back_to_system(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            worker = self._create_worker(root / "settings.json")

            saved = worker.handle_request(
                "save_settings",
                {
                    "settings": {
                        "input_dir": str(root),
                        "uiLanguage": "fr",
                    }
                },
            )
            self.assertEqual(saved["settings"]["uiLanguage"], "fr")

            fallback = worker.handle_request(
                "save_settings",
                {
                    "settings": {
                        "input_dir": str(root),
                        "uiLanguage": "jp",
                    }
                },
            )
            self.assertEqual(fallback["settings"]["uiLanguage"], "system")

    def test_scan_videos_supports_subdirs_and_natural_sort(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "clip10.mp4").write_bytes(b"")
            (root / "clip2.mp4").write_bytes(b"")
            (root / "nested").mkdir()
            (root / "nested" / "clip1.m4v").write_bytes(b"")

            worker = self._create_worker(root / "settings.json")

            result = worker.handle_request(
                "scan_videos",
                {"directory": str(root), "include_subdirs": True},
            )

            self.assertEqual(
                [item["fileName"] for item in result["items"]],
                ["clip1.m4v", "clip2.mp4", "clip10.mp4"],
            )

    def test_start_processing_emits_events_and_preserves_files_in_dry_run(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "clip2.mp4"
            second = root / "clip10.m4v"
            first.write_bytes(b"")
            second.write_bytes(b"")

            events: list[dict[str, object]] = []
            extracted_frames: list[str] = []

            def frame_extractor(path: Path, frame_number_1based: int) -> bytes:
                extracted_frames.append(f"{path.name}:{frame_number_1based}")
                return b"preview-bytes"

            def ocr_recognizer(
                png_bytes: bytes,
                *,
                endpoint: str,
                api_key: str,
                secret_key: str,
            ) -> str:
                self.assertEqual(png_bytes, b"preview-bytes")
                self.assertEqual(endpoint, "general_basic")
                self.assertEqual(api_key, "baidu-key")
                self.assertEqual(secret_key, "baidu-secret")
                return "OCR TEXT"

            def title_extractor(**kwargs: object) -> str:
                self.assertEqual(kwargs["api_key"], "deepseek-key")
                self.assertEqual(kwargs["base_url"], "https://api.deepseek.com/v1")
                self.assertEqual(kwargs["model"], "deepseek-chat")
                self.assertTrue(kwargs["thinking_enabled"])
                self.assertEqual(kwargs["ocr_text"], "OCR TEXT")
                return "Action Title"

            worker = self._create_worker(
                root / "settings.json",
                emit=events.append,
                frame_extractor=frame_extractor,
                ocr_recognizer=ocr_recognizer,
                title_extractor=title_extractor,
            )

            worker.handle_request(
                "save_settings",
                {
                    "settings": {
                        "input_dir": str(root),
                        "include_subdirs": False,
                        "frame_number_1based": 5,
                        "start_index": 1,
                        "index_padding": 3,
                        "dry_run": True,
                        "baidu_ocr_mode": "general_basic",
                        "deepseek_base_url": "https://api.deepseek.com/v1",
                        "deepseek_model": "deepseek-chat",
                        "deepseek_system_prompt": "system",
                        "deepseek_user_prompt_template": "user {ocr_text}",
                        "recent_dirs": [str(root)],
                    }
                },
            )
            worker.handle_request("scan_videos", {"directory": str(root), "include_subdirs": False})
            worker.handle_request(
                "start_processing",
                {
                    "secrets": {
                        "baiduApiKey": "baidu-key",
                        "baiduSecretKey": "baidu-secret",
                        "deepseekApiKey": "deepseek-key",
                    }
                },
            )
            worker.wait_for_idle(timeout=3)

            self.assertEqual(extracted_frames, ["clip2.mp4:5", "clip10.m4v:5"])
            self.assertTrue(first.exists())
            self.assertTrue(second.exists())
            self.assertIn("item_preview", [event["event"] for event in events])
            self.assertIn("item_ocr", [event["event"] for event in events])
            self.assertIn("item_title", [event["event"] for event in events])
            self.assertIn("done", [event["event"] for event in events])

            items = worker.handle_request("get_items", {})
            self.assertEqual(items["items"][0]["suggestedTitle"], "Action Title")
            self.assertEqual(items["items"][0]["newName"], "001-Action Title.mp4")
            self.assertEqual(items["items"][1]["newName"], "002-Action Title.m4v")

    def test_generate_title_preserves_deepseek_raw_text(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "clip.mp4"
            video.write_bytes(b"")
            events: list[dict[str, object]] = []

            def title_extractor(**kwargs: object) -> dict[str, str]:
                self.assertEqual(kwargs["ocr_text"], "OCR TEXT")
                self.assertTrue(kwargs["thinking_enabled"])
                return {
                    "title": "Action Title",
                    "raw_text": "Action Title\nreasoning and alternate wording",
                }

            worker = self._create_worker(
                root / "settings.json",
                emit=events.append,
                title_extractor=title_extractor,
            )
            worker.handle_request(
                "save_settings",
                {
                    "settings": {
                        "input_dir": str(root),
                        "deepseek_base_url": "https://api.deepseek.com/v1",
                        "deepseek_model": "deepseek-chat",
                        "deepseek_system_prompt": "system",
                        "deepseek_user_prompt_template": "user {ocr_text}",
                    }
                },
            )
            scan_result = worker.handle_request("scan_videos", {"directory": str(root), "include_subdirs": False})
            item_id = scan_result["items"][0]["id"]
            worker.handle_request("save_ocr_edit", {"id": item_id, "text": "OCR TEXT"})

            result = worker.handle_request(
                "generate_title_from_ocr",
                {
                    "id": item_id,
                    "secrets": {
                        "baiduApiKey": "baidu-key",
                        "baiduSecretKey": "baidu-secret",
                        "deepseekApiKey": "deepseek-key",
                    },
                },
            )

            self.assertEqual(result["item"]["suggestedTitle"], "Action Title")
            self.assertEqual(result["item"]["deepseekRawText"], "Action Title\nreasoning and alternate wording")

            title_event = next(event for event in events if event["event"] == "item_title")
            self.assertEqual(title_event["deepseekRawText"], "Action Title\nreasoning and alternate wording")

            log_event = next(
                event
                for event in events
                if event["event"] == "log" and "reasoning and alternate wording" in str(event["message"])
            )
            self.assertIn("clip.mp4", str(log_event["message"]))

    def test_stop_processing_stops_after_current_item(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "clip1.mp4"
            second = root / "clip2.mp4"
            first.write_bytes(b"")
            second.write_bytes(b"")

            events: list[dict[str, object]] = []
            started = threading.Event()
            release = threading.Event()

            def frame_extractor(path: Path, frame_number_1based: int) -> bytes:
                if path.name == "clip1.mp4":
                    started.set()
                    release.wait(timeout=2)
                return b"preview"

            worker = self._create_worker(
                root / "settings.json",
                emit=events.append,
                frame_extractor=frame_extractor,
                ocr_recognizer=lambda *args, **kwargs: "OCR",
                title_extractor=lambda **kwargs: "Stopped Title",
            )

            worker.handle_request(
                "save_settings",
                {
                    "settings": {
                        "input_dir": str(root),
                        "include_subdirs": False,
                        "frame_number_1based": 1,
                        "start_index": 1,
                        "index_padding": 3,
                        "dry_run": True,
                        "baidu_ocr_mode": "accurate_basic",
                        "deepseek_base_url": "https://api.deepseek.com/v1",
                        "deepseek_model": "deepseek-chat",
                        "deepseek_system_prompt": "system",
                        "deepseek_user_prompt_template": "user {ocr_text}",
                        "recent_dirs": [str(root)],
                    }
                },
            )
            worker.handle_request("scan_videos", {"directory": str(root), "include_subdirs": False})
            worker.handle_request(
                "start_processing",
                {
                    "secrets": {
                        "baiduApiKey": "baidu-key",
                        "baiduSecretKey": "baidu-secret",
                        "deepseekApiKey": "deepseek-key",
                    }
                },
            )

            self.assertTrue(started.wait(timeout=1))
            worker.handle_request("stop_processing", {})
            release.set()
            worker.wait_for_idle(timeout=3)

            items = worker.handle_request("get_items", {})["items"]
            self.assertEqual(items[0]["suggestedTitle"], "Stopped Title")
            self.assertEqual(items[1]["status"], "待处理")
            self.assertIn("done", [event["event"] for event in events])

    def test_rename_one_uses_edited_title_and_avoids_collisions(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            existing = root / "002-Custom Title.mp4"
            target = root / "raw.mp4"
            existing.write_bytes(b"existing")
            target.write_bytes(b"raw")

            worker = self._create_worker(root / "settings.json")
            worker.handle_request(
                "save_settings",
                {
                    "settings": {
                        "input_dir": str(root),
                        "include_subdirs": False,
                        "frame_number_1based": 1,
                        "start_index": 1,
                        "index_padding": 3,
                        "dry_run": False,
                        "baidu_ocr_mode": "accurate_basic",
                        "deepseek_base_url": "https://api.deepseek.com/v1",
                        "deepseek_model": "deepseek-chat",
                        "deepseek_system_prompt": "system",
                        "deepseek_user_prompt_template": "user {ocr_text}",
                        "recent_dirs": [str(root)],
                    }
                },
            )
            scan_result = worker.handle_request("scan_videos", {"directory": str(root), "include_subdirs": False})
            item_id = next(item["id"] for item in scan_result["items"] if item["fileName"] == "raw.mp4")
            worker.handle_request("save_title_edit", {"id": item_id, "title": "Custom Title"})

            rename_result = worker.handle_request("rename_one", {"id": item_id})

            self.assertEqual(rename_result["item"]["fileName"], "002-Custom Title_2.mp4")
            self.assertTrue((root / "002-Custom Title_2.mp4").exists())
            self.assertFalse(target.exists())

    def test_rename_one_accepts_manual_index_override(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "001-Existing.mp4").write_bytes(b"existing")
            target = root / "raw.mp4"
            target.write_bytes(b"raw")

            worker = self._create_worker(root / "settings.json")
            worker.handle_request(
                "save_settings",
                {
                    "settings": {
                        "input_dir": str(root),
                        "include_subdirs": False,
                        "frame_number_1based": 1,
                        "start_index": 1,
                        "index_padding": 3,
                        "dry_run": False,
                    }
                },
            )
            scan_result = worker.handle_request("scan_videos", {"directory": str(root), "include_subdirs": False})
            item_id = next(item["id"] for item in scan_result["items"] if item["fileName"] == "raw.mp4")

            rename_result = worker.handle_request("rename_one", {"id": item_id, "title": "Custom Title", "index": 7})

            self.assertEqual(rename_result["item"]["fileName"], "007-Custom Title.mp4")
            self.assertTrue((root / "007-Custom Title.mp4").exists())
            self.assertFalse(target.exists())

    def test_rename_one_follows_existing_folder_padding_for_single_video(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "0001-Existing.mp4").write_bytes(b"existing")
            target = root / "raw.mp4"
            target.write_bytes(b"raw")

            worker = self._create_worker(root / "settings.json")
            worker.handle_request(
                "save_settings",
                {
                    "settings": {
                        "input_dir": str(root),
                        "index_padding": 2,
                        "dry_run": False,
                    }
                },
            )
            result = worker.handle_request("load_single_video", {"filePath": str(target)})
            item_id = result["items"][0]["id"]

            rename_result = worker.handle_request("rename_one", {"id": item_id, "title": "Custom Title"})

            self.assertEqual(rename_result["item"]["fileName"], "0002-Custom Title.mp4")
            self.assertTrue((root / "0002-Custom Title.mp4").exists())

    def test_rename_one_uses_config_padding_when_single_video_folder_has_no_indexed_files(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "raw.mp4"
            target.write_bytes(b"raw")

            worker = self._create_worker(root / "settings.json")
            worker.handle_request(
                "save_settings",
                {
                    "settings": {
                        "input_dir": str(root),
                        "index_padding": 5,
                        "dry_run": False,
                    }
                },
            )
            result = worker.handle_request("load_single_video", {"filePath": str(target)})
            item_id = result["items"][0]["id"]

            rename_result = worker.handle_request("rename_one", {"id": item_id, "title": "Custom Title"})

            self.assertEqual(rename_result["item"]["fileName"], "00001-Custom Title.mp4")
            self.assertTrue((root / "00001-Custom Title.mp4").exists())

    def test_load_single_video_returns_one_item_and_index_suggestion(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "001-Opening.mp4").write_bytes(b"one")
            (root / "003-Move.mp4").write_bytes(b"three")
            target = root / "raw.mp4"
            target.write_bytes(b"raw")

            worker = self._create_worker(root / "settings.json")
            result = worker.handle_request("load_single_video", {"filePath": str(target)})

            self.assertEqual([item["fileName"] for item in result["items"]], ["raw.mp4"])
            self.assertEqual(result["indexSuggestion"]["suggestedIndex"], 2)
            self.assertEqual(result["indexSuggestion"]["candidateIndexes"], [2])
            self.assertEqual(result["indexSuggestion"]["suggestedIndexPadding"], 3)

    def test_rename_source_directory_updates_config_and_items(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "source-videos"
            source_dir.mkdir()
            video_path = source_dir / "clip1.mp4"
            video_path.write_bytes(b"clip")
            other_dir = root / "other"
            other_dir.mkdir()

            worker = self._create_worker(root / "settings.json")
            worker.handle_request(
                "save_settings",
                {
                    "settings": {
                        "input_dir": str(source_dir),
                        "include_subdirs": False,
                        "frame_number_1based": 1,
                        "start_index": 1,
                        "index_padding": 3,
                        "dry_run": False,
                        "baidu_ocr_mode": "accurate_basic",
                        "deepseek_base_url": "https://api.deepseek.com/v1",
                        "deepseek_model": "deepseek-chat",
                        "deepseek_system_prompt": "system",
                        "deepseek_user_prompt_template": "user {ocr_text}",
                        "recent_dirs": [str(source_dir), str(other_dir)],
                    }
                },
            )
            worker.handle_request("scan_videos", {"directory": str(source_dir), "include_subdirs": False})

            result = worker.handle_request(
                "rename_source_directory",
                {
                    "directory": str(source_dir),
                    "newName": "renamed-videos",
                },
            )

            renamed_dir = root / "renamed-videos"
            self.assertFalse(source_dir.exists())
            self.assertTrue(renamed_dir.exists())
            self.assertEqual(result["inputDir"], str(renamed_dir))
            self.assertEqual(result["recentDirs"], [str(renamed_dir), str(other_dir)])
            self.assertEqual(result["items"][0]["fullPath"], str(renamed_dir / "clip1.mp4"))

            settings = worker.handle_request("load_settings", {})
            self.assertEqual(settings["settings"]["inputDir"], str(renamed_dir))

    def _create_worker(
        self,
        config_path: Path,
        *,
        emit=None,
        frame_extractor=None,
        ocr_recognizer=None,
        title_extractor=None,
    ) -> DesktopWorker:
        return DesktopWorker(
            config_path=config_path,
            emit=emit or (lambda event: None),
            frame_extractor=frame_extractor,
            ocr_recognizer=ocr_recognizer,
            title_extractor=title_extractor,
        )


if __name__ == "__main__":
    unittest.main()
