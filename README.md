# Token Usage Dashboard

本機 Electron 儀表板，讀取 Claude Code 與 Codex 的本機 JSONL 使用紀錄，顯示額度、使用量及目前前景終端的 session context。

## 下載與啟動

從 [Releases](https://github.com/Gp3ShenQ/token-usage-dashboard/releases/latest) 下載 `token-usage-dashboard-portable.exe`，免安裝直接執行；自行打包則執行 `release\token-usage-dashboard-portable.exe`。執行檔未經程式碼簽章，首次執行若出現 Windows SmartScreen，請選「其他資訊 → 仍要執行」。程式會常駐系統匣；關閉視窗只會隱藏，請由系統匣選擇「結束程式」才會完全關閉。

## 前景終端與 session 自動辨識

Widget 不需要手動切換 Claude 或 Codex。當前景 PowerShell 終端以 `codex` 或 `claude` 啟動新 session 時，PowerShell profile 會執行 `scripts\start-agent-session.ps1`，並在**同一個 Windows Terminal 視窗**建立一個受控新分頁：

1. 新分頁標題固定為 `Codex · <分頁短碼>` 或 `Claude · <分頁短碼>`，且 Windows Terminal 會禁止 CLI 覆寫它。
2. 啟動腳本在本機偵測或指定實際 session ID，寫入 `%LOCALAPPDATA%\TokenUsageDashboard\session-bindings\` 的對應檔。
3. Dashboard 以目前選中分頁的 agent + 分頁短碼讀取對應檔，查找正確 session，顯示任務狀態、模型與 Context 使用率。

同一個 Windows Terminal 視窗的多個 tab 共用程序樹，無法用 PID 辨識目前選中的 tab。因此 Dashboard 不再用程序樹猜測 agent，也不會受 Claude 思考時的動態標題影響。只有由上述 wrapper 開啟、標題符合固定格式的分頁才會被辨識；舊分頁會顯示「等資料」，避免誤判成另一個 agent。

### 設定 PowerShell profile

在 PowerShell 執行 `notepad $PROFILE`，加入一行（路徑改成本 repo 的實際位置）：

```powershell
. "<repo>\scripts\agent-wrappers.ps1"
```

`agent-wrappers.ps1` 會從 `PATH` 找出 `codex` 與 `claude` 的實際執行檔，並以同名函式包裝；找不到的 CLI 不會被包裝。若要替特定專案建立捷徑，可在 profile 自行加上：

```powershell
function claude-myapp {
  & $tokenUsageDashboardWrapper -Agent claude -ExecutablePath $claudeExecutable -WorkingDirectory 'D:\src\myapp' -AgentArguments $args
}
```

修改 profile 或 Windows Terminal 設定後必須重新開 PowerShell；既有 session 沒有短 ID 標題時，Widget 會顯示「等資料」。

注意：從互動式 PowerShell 輸入的 `codex` 或 `claude`（包含帶明確 UUID 的 `--resume` 等參數）都會經過 wrapper，並開啟受控新分頁。若是自動化腳本，請直接使用 CLI 的完整執行檔路徑，避免不需要的 wrapper 監測。Claude 的新 session 會先指定 session ID；Codex 則在啟動後最多 45 秒內偵測新建的 JSONL 取得 ID。

## 工作階段監測（hook / statusLine）

任務狀態、Claude 的 Context 使用率與「本輪回覆已結束」通知需要安裝 monitor：

```powershell
node scripts/install-monitor.mjs   # 預覽：只列出會變更的檔案，不寫入
npm run monitor:install            # 實際安裝
```

- Claude：在 `~/.claude/settings.json` 加入 `scripts/monitor-hook.mjs` hooks，並以 `scripts/monitor-statusline.mjs` 包裝既有 statusLine（原輸出不變；既有 statusLine 必須是單一 Node 腳本，否則不會修改）。
- Codex：在 `~/.codex/config.toml` 加入以標記包住的 hooks 區塊，安裝後請到 Codex `/hooks` 確認信任。
- 寫入前會在原檔旁建立 `.token-hud-<時間>.bak` 備份；重複執行不會重複加入。
- 事件寫入 `%LOCALAPPDATA%\TokenUsageDashboard\monitor\`，只記錄事件類型、工具名稱、模型與 Context 資訊，不含對話內容。

## Context 使用率

Widget 顯示目前 session 的 Context 百分比：

- Claude：取自 statusLine 回報的 `context_window.used_percentage`，需先安裝 monitor。
- Codex：以 JSONL 最新一筆 `last_token_usage.total_tokens` ÷ `model_context_window` 估算，標示為「Context ≈」。

若分頁短碼尚未綁定或 session 不唯一，Widget 不會猜測 session，而會顯示「等資料」。

## 開發與打包

需求：Windows、Node.js、Windows Terminal、PowerShell 7。

```powershell
npm install
npm run dev
npm run typecheck
npm run test:monitor      # vitest 單元測試
npm run test:monitor-ui   # Electron UI 檢查
npm run build
```

`npm run build` 會產生 `release\token-usage-dashboard-portable.exe`。封裝前請關閉正在執行的 Dashboard，否則 Windows 會鎖住 portable 執行檔而無法覆寫。

## 分支與發佈

- `dev`：日常開發。push 後 CI 會執行 typecheck、編譯與單元測試。
- `main`：只接受由 `dev` 合併（建議透過 PR，CI 通過後再合併）。
- 合併進 `main` 時，Release workflow 讀取 `package.json` 的 `version`：若 tag `v<version>` 不存在，就測試、打包、建立 tag 並發佈 Release；已存在則略過。因此**只有提升版號才會發佈**，其他合併不會產生新版本。
- CI 會實際打包並啟動打包後的程式（UI 檢查與冒煙測試），並以 `scripts/check-version.mjs` 拒絕低於已發佈版本的版號；打包好的 exe 會保留 7 天，可在該次 Actions 執行頁面下載試用。
- 每個 Release 附有 `.sha256`，下載後可用 `Get-FileHash token-usage-dashboard-portable.exe` 核對。

### 版號規則

採 [Semantic Versioning](https://semver.org/lang/zh-TW/)：`MAJOR.MINOR.PATCH`。

| 變更類型 | 升級 | 範例 |
| --- | --- | --- |
| 不相容變更：設定檔格式、session 綁定或交接檔格式改變、需重新執行 `monitor:install`、移除功能 | MAJOR | `1.4.2` → `2.0.0` |
| 新增功能，舊設定與資料仍可用 | MINOR | `1.4.2` → `1.5.0` |
| 錯誤修正、效能、文字或樣式調整 | PATCH | `1.4.2` → `1.4.3` |
| 試用版 | 加上 `-beta.N` | `1.5.0-beta.1`（發佈為 Pre-release） |

- `1.0.0` 之前（`0.y.z`）視為開發期：不相容變更升 MINOR，其餘升 PATCH。
- 只改文件、CI 或測試不需升版。
- 已發佈的版號不可重用；發佈有誤時升 PATCH 重新發佈，不刪除或移動既有 tag。

### 發佈步驟

```powershell
git switch dev
npm version minor --no-git-tag-version   # 或 patch / major / prerelease --preid beta
git commit -am "chore(release): v<新版號>"
git push origin dev
# 在 GitHub 建立 dev → main 的 PR，CI 通過後合併
```

不要手動建立 `v*` tag；tag 由 Release workflow 建立。

## 一次性交接報告（試用）

terminal 卡片只在 Context 大於 72% 時顯示兩個交接按鈕與提示；等於或低於 72%、以及數值未知時隱藏。產生交接仍需完整綁定 session：

- Codex：「產生交接報告」會等待原 session 閒置，再使用本機 CLI 的 `queue --thread` 派送指令；需要支援此命令且可連線的本機 daemon。失敗或逾時不自動重送，可改用「複製交接指令」，先確認原 AI 未收到再貼上。
- Claude：「複製交接指令」，由使用者貼至同一個原 session，讓 AI 依自己的上下文整理報告。
- 報告通過來源、完整 session ID、工作目錄與必要內容核對後，按鈕變成「複製接手指令」。手動開啟同工作目錄的新 session 並貼上；指令要求新 AI 完整讀取、核對 SHA-256 後刪除該份報告，接收失敗則保留。

報告存於 Electron 使用者資料目錄的 `handoffs/handoff-<唯一識別碼>.json`。不覆寫全域交接檔、不自動開新 session、不關閉原 session；交接內容不構成續作授權。Context 門檻只控制按鈕顯示，不會自動產生報告。刪除由接收端 AI 執行，Dashboard 只回報檔案已移除，不將刪除視為接收成功的證明。
「複製交接報告內容」會將接收指令與完整 JSON 報告一起複製到剪貼簿，包含原檔確切路徑、交接識別資料及 SHA-256，可直接貼至同工作目錄的新對話；尚未就緒時停用。新 AI 須完整讀取報告並核對指定原檔，成功接收且再次確認雜湊未變後，只刪除該單一報告；核對或刪除失敗須明確回報，不搜尋或刪除其他檔案。複製當下不刪除原檔，接收也不構成續作授權。

接收端須在刪除報告前寫入同目錄的 `handoff-<唯一識別碼>.receipt.json`，只記錄交接身分、雜湊、接收時間、接收 session（無法取得時為 null）及刪除結果，不存正文。寫入失敗就保留報告；刪除後更新結果。舊報告重新複製接手指令或報告內容即可取得新規則；已貼出的舊指令不會自動更新。

Dashboard「設定」中的「交接紀錄」不受 Context 門檻限制，可重新整理並區分等待接收、已接收待移除、接收完成及檔案已移除但接收未確認。接收紀錄是接收端的回報，不保證其後續上下文仍完整。

清理採手動確認：已完成交接可清理請求及接收紀錄；未接收報告須個別選取並確認，才刪除指定報告與對應請求。正在派送、尚未產生、已接收待移除、識別或雜湊不符的資料不會被清理。沒有自動清理或保留期限。清理部分失敗時保留必要紀錄，重新整理後可再處理；不掃描其他目錄或刪除原始 AI log。
