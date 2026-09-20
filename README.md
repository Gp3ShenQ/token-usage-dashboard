# Token Usage Dashboard

本機 Electron 儀表板，讀取 Claude Code 與 Codex 的本機 JSONL 使用紀錄，顯示額度、使用量及目前前景終端的 session context。

## 啟動

執行 `release\token-usage-dashboard-portable.exe`。程式會常駐系統匣；關閉視窗只會隱藏，請由系統匣選擇「結束程式」才會完全關閉。

## 前景終端與 session 自動辨識

Widget 不需要手動切換 Claude 或 Codex。當前景 PowerShell 終端以 `codex` 或 `claude` 啟動新 session 時，PowerShell profile 會執行 `scripts\start-agent-session.ps1`，並在**同一個 Windows Terminal 視窗**建立一個受控新分頁：

1. 新分頁標題固定為 `Codex · <分頁短碼>` 或 `Claude · <分頁短碼>`，且 Windows Terminal 會禁止 CLI 覆寫它。
2. 啟動腳本在本機偵測或指定實際 session ID，寫入 `%LOCALAPPDATA%\TokenUsageDashboard\session-bindings\` 的對應檔。
3. Dashboard 以目前選中分頁的 agent + 分頁短碼讀取對應檔，查找正確 session，顯示最新一次送出的 input tokens。

同一個 Windows Terminal 視窗的多個 tab 共用程序樹，無法用 PID 辨識目前選中的 tab。因此 Dashboard 不再用程序樹猜測 agent，也不會受 Claude 思考時的動態標題影響。只有由上述 wrapper 開啟、標題符合固定格式的分頁才會被辨識；舊分頁會顯示「等資料」，避免誤判成另一個 agent。

PowerShell profile 位置為 `$PROFILE`。因此修改 profile 或 Windows Terminal 設定後必須重新開 PowerShell；既有 session 沒有短 ID 標題時，Widget 會顯示「等資料」。

注意：從互動式 PowerShell 輸入的 `codex` 或 `claude`（包含帶明確 UUID 的 `--resume` 等參數）都會經過 wrapper，並開啟受控新分頁。若是自動化腳本，請直接使用 CLI 的完整執行檔路徑，避免不需要的 wrapper 監測。Claude 的新 session 會先指定 session ID；Codex 則在啟動後最多 45 秒內偵測新建的 JSONL 取得 ID。

## Context 警示

「最新送出」使用該 session 最新一筆 JSONL 的 `input_tokens`，不是累積用量，也不包含 output 或 cache tokens。

- 未滿 50k：正常
- 50k 以上：黃色，建議準備交接
- 100k 以上：紅色，建議開新 session

若短 ID 尚未掃描到或不唯一，Widget 不會猜測 session，而會顯示等待狀態。

## 開發與打包

```powershell
npm run dev
npm run typecheck
npm run build
```

`npm run build` 會產生 `release\token-usage-dashboard-portable.exe`。封裝前請關閉正在執行的 Dashboard，否則 Windows 會鎖住 portable 執行檔而無法覆寫。

## 一次性交接報告（試用）

完整綁定 session 的 terminal 卡片會顯示交接按鈕：

- Codex：「產生交接報告」會等待原 session 閒置，再使用本機 CLI 的 `queue --thread` 派送指令；需要支援此命令且可連線的本機 daemon。失敗或逾時不自動重送，可改用「複製交接指令」，先確認原 AI 未收到再貼上。
- Claude：「複製交接指令」，由使用者貼至同一個原 session，讓 AI 依自己的上下文整理報告。
- 報告通過來源、完整 session ID、工作目錄與必要內容核對後，按鈕變成「複製接手指令」。手動開啟同工作目錄的新 session 並貼上；指令要求新 AI 完整讀取、核對 SHA-256 後刪除該份報告，接收失敗則保留。

報告存於 Electron 使用者資料目錄的 `handoffs/handoff-<唯一識別碼>.json`。不覆寫全域交接檔、不自動開新 session、不關閉原 session；交接內容不構成續作授權。此版提供手動入口，尚未設定 Context 比例的換 session 建議門檻。刪除由接收端 AI 執行，Dashboard 只回報檔案已移除，不將刪除視為接收成功的證明。
「複製交接報告內容」會將接收指令與完整 JSON 報告一起複製到剪貼簿，包含原檔確切路徑、交接識別資料及 SHA-256，可直接貼至同工作目錄的新對話；尚未就緒時停用。新 AI 須完整讀取報告並核對指定原檔，成功接收且再次確認雜湊未變後，只刪除該單一報告；核對或刪除失敗須明確回報，不搜尋或刪除其他檔案。複製當下不刪除原檔，接收也不構成續作授權。
