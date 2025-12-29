from __future__ import annotations

import traceback


def main() -> int:
    try:
        from videotitler.gui import run_app

        run_app()
        return 0
    except Exception as exc:
        traceback.print_exc()
        message = f"{exc}\n\n提示：请先运行：python -m pip install -r requirements.txt"
        try:
            import tkinter as tk
            from tkinter import messagebox

            root = tk.Tk()
            root.withdraw()
            messagebox.showerror("VideoTitler 启动失败", message)
            root.destroy()
        except Exception:
            print(message)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
