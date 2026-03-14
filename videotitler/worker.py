from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

from videotitler.config import default_config_path
from videotitler.desktop_worker import DesktopWorker, WorkerProtocol


def _resolve_config_path() -> Path:
    configured = os.environ.get("VIDEOTITLER_SETTINGS_PATH", "").strip()
    if configured:
        return Path(configured)
    return default_config_path()


def main() -> int:
    try:
        config_path = _resolve_config_path()
        protocol = WorkerProtocol()
        worker = DesktopWorker(config_path=config_path, emit=protocol.emit)

        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
                request_id = str(request["requestId"])
                method = str(request["method"])
                params = request.get("params") or {}
                if not isinstance(params, dict):
                    raise ValueError("params must be an object")

                payload = worker.handle_request(method, params)
                protocol.respond(request_id, True, payload=payload)

                if method == "shutdown":
                    break
            except Exception as exc:
                request_id = None
                try:
                    parsed = json.loads(line)
                    request_id = str(parsed.get("requestId", ""))
                except Exception:
                    request_id = ""
                protocol.respond(request_id, False, error=str(exc) or traceback.format_exc().strip())
        return 0
    except Exception:
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
