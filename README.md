# VideoTitler

从指定目录批量读取视频，截取第 X 帧 → 百度 OCR 识别 → DeepSeek 提炼“游戏角色动作指引”标题 → 重命名为 `序号-标题`。

## 安装

在项目目录下：

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

另外需要安装 `ffmpeg` 并确保可在命令行直接执行 `ffmpeg`（已加入 PATH）。

## 运行

```powershell
.\.venv\Scripts\python.exe .\main.py
```

## 使用说明

- 在 GUI 中选择“视频目录”，点击“扫描”
- 设置“第 X 帧(从1开始)”
- 填写百度 OCR 的 `API Key / Secret Key`（从百度智能云控制台获取）
- 填写 DeepSeek 的 `API Key`
- 点击“开始处理”

提示：
- 勾选“仅预览(不改名)”可先检查提取结果
- 勾选“保存密钥到本地 config.json”会把密钥明文保存在本项目目录，请自行注意安全
- “密钥/设置”中可修改 DeepSeek Prompt；`User Prompt 模板`支持占位符 `{ocr_text}`
- 在 “OCR/日志” 页可手动编辑 OCR 结果/标题，并对单条视频重新生成标题或重命名（失败的也可以补救）
- OCR 默认使用百度“高精度”(`accurate_basic`)，可在主界面下拉切换为通用(`general_basic`)
- 如果先勾选“仅预览(不改名)”跑一遍，可在确认/编辑标题后点击“重命名全部”一次性执行改名
