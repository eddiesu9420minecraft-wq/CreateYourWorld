# CYW 反饋中心（Feedback Center）

狀態：**本機開發完成，尚未部署**。後端在本機（wrangler dev／Miniflare）完整運作；Cloudflare 帳號、D1、R2、GitHub OAuth App、Token 與 Webhook Secret 都**尚未建立**，需要你的批准。

架構（2026-11-28 由你選定）：
- **後端**：Cloudflare Worker＋D1＋R2，程式在 `services/feedback/`。採本機優先開發。
- **身分**：GitHub 裝置登入。
- **API 合約**：[`API.md`](API.md)。

```
CYW 視窗 (React) ──invoke──▶ Rust (cyw-core::feedback) ──HTTPS / DoH / 主機白名單──▶ Worker ──▶ D1 / R2
                                     │ 遮蔽、移除中繼資料、預覽雜湊                           └──▶ GitHub API（Token 只在 Worker）
WebView 的 CSP 不允許直接連外：所有請求都經過 Rust。
```

## 功能清單

### 使用者
- 獨立的「反饋中心」頁面（側邊欄），未讀通知數會顯示在導覽列。
- 類別：Bug 回報、功能建議、效能問題、相容性問題、一般反饋。
- 可回報 CYW 生態系中任何已上架的軟體：產品目錄中的所有軟體，加上 CYW 本身。已安裝的版本會顯示在選單中。
- 附件：
  - PNG／JPEG／WebP 截圖（≤ 4 MiB）。可用檔案選擇器加入，也可以直接貼上。
  - 文字錯誤日誌（≤ 1 MiB）。
  - 可選的「CYW 診斷日誌」：最近的下載／安裝錯誤、自我更新錯誤、PATH 問題。
  - 每則最多 5 個附件，總計 ≤ 8 MiB。
  - 類型依檔案內容判斷，不看副檔名：改名成 .png 的執行檔會被拒絕。
- 自動取得軟體版本（已安裝版本）、CYW 版本、作業系統與版本、CPU 架構。可以取消勾選；勾選時也會先顯示在預覽中。
- **上傳前預覽並確認**：
  - 預覽列出標題、內容、環境資訊、每個附件（圖片縮圖、遮蔽後的日誌全文）、遮蔽統計，以及完整的 JSON。
  - 要勾選「我已檢查以上內容，同意上傳」，「確認並上傳」才會啟用。
  - Rust 端只上傳和預覽 SHA-256 完全相同的內容：不符、逾時（30 分鐘）或重複送出都會被拒絕。
  - 一般的 API 橋接不能建立反饋、上傳附件或呼叫登入端點，無法繞過預覽。
- 搜尋（標題＋內容）與篩選（軟體、類別、狀態）。排序：最新、最多票、最近更新。可分頁。
- 投票、留言（留言送出前也會遮蔽）、追蹤／取消追蹤。
- 狀態追蹤：待處理 → 已確認 → 處理中 → 已修復（待發布）→ 已發布修復，以及已關閉（含原因）。有處理紀錄時間軸。
- 通知：
  - 觸發時機：開發者回覆、狀態變更、修復版本正式發布。
  - 登入時每 10 分鐘在背景檢查一次。修復版本發布時會跳出提示。
- 回報者可以自行關閉自己的反饋（已解決）。

### 開發者／維護者
- 權限分離：
  - 角色：`user` < `developer` < `maintainer`，另有服務身分 `agent`（AI Agent）與 `cyws`。
  - 一律由伺服器判斷權限；UI 只決定顯示哪些按鈕。
- 開發者回覆（標示「開發者回覆」並通知追蹤者），變更狀態、指派、標籤、關閉（完成、重複、不修正、無效、垃圾訊息）。
- 維護者：
  - 隱藏留言、封鎖使用者、管理角色、發行服務 Token。
  - 把反饋轉換為 CYWS 開發任務、指派開發者。
- 只有開發者與回報者看得到附件與環境資訊。

### GitHub Issues 雙向同步
- CYW → GitHub：
  - 「同步到 GitHub Issues」會在對應的 repo 建立 Issue，內容為遮蔽後的文字、已同意的環境資訊，加上「不可信任內容」標示。附件不會上傳到 GitHub。
  - 之後的留言、關閉與重新開啟都會同步過去。
- GitHub → CYW：
  - Webhook 會驗證 HMAC，並去除重複的 delivery。
  - 會同步的事件：Issue 留言、關閉、重新開啟，以及 `release.published`。
  - 用標記與 bot 帳號避免同步迴圈。
- GitHub Token 只存在 Worker 的 Secret，不會進入客戶端。使用者的 GitHub Token 只用來讀取一次 `/user`，然後就丟棄。

### CYWS 整合
- 反饋 → CYWS 開發任務。任務中使用者提供的文字都放在 `source` 之下，並標示 `untrusted: true` 與處理守則。
- 維護者可以指派任務。AI Agent（服務 Token）可以：
  - 讀取任務、加入分析；
  - 連結**同一個 repo** 的修復 PR；
  - 把狀態改為「進行中」或「審核中」。
- AI Agent 不能完成或關閉任務，不能把反饋標為已發布，也不能呼叫發布紀錄 API。
- 「記錄已發布的修復版本」只會記錄**人工已在 GitHub 發布**的版本並通知使用者。它需要維護者的工作階段，並勾選人工確認（`human_approved: true`）。整個系統沒有任何發布版本的程式。

### 安全與隱私
- 自動遮蔽：
  - 客戶端在 Rust 遮蔽，伺服器端會用同樣的規則再遮蔽一次。
  - 遮蔽對象：私鑰（PEM、OpenSSH、minisign）、各種 Token（GitHub、AWS、Slack、OpenAI／Anthropic、Stripe、Google、JWT、Bearer）、`password=`／`api_key:` 等設定值、網址中的帳密、電子郵件、IPv4／IPv6、MAC、本機使用者名稱、電腦名稱、家目錄，以及 `.ssh`、`.aws`、`.gnupg`、`.kube`、Credentials、Keychains 等敏感路徑。
- 圖片會移除 EXIF／GPS、XMP、PNG 文字區塊、JPEG 註解，伺服器也會拒絕仍帶有中繼資料的圖片。附件只用原本的檔名送出，不含本機資料夾路徑。
- 沒有經過你的確認，不會上傳任何資料。預覽本身不會連線。
- 速率限制（D1 固定視窗，429 加 `Retry-After`）：
  - 登入：每 IP 每 10 分鐘 20 次。
  - 新增反饋：每小時 5 則、每天 20 則。
  - 留言：每小時 30 則。
  - 投票：每小時 120 次。
  - 附件：每小時 20 個。
  - 讀取：每 IP 每 10 分鐘 600 次。
- 防垃圾訊息：
  - 隱藏欄位（honeypot）、最多 5 個連結、24 小時內相同內容會被拒絕。
  - 註冊未滿 7 天的 GitHub 帳號每天只能送出 1 則。
  - 封鎖名單。
- 大小限制：JSON ≤ 64 KiB，附件依類型限制。
- 反饋內容一律視為資料：
  - UI 只以純文字顯示，不轉成 HTML 或 Markdown。
  - CSP 不允許 WebView 直接連外。
  - 交給 AI Agent 的任務都標示為不可信任。
- 工作階段 Token 存放方式：Windows 以 DPAPI 加密，macOS／Linux 的檔案權限為 0600。Token 只會送往發出它的後端。
- 連線規則：
  - 正式網址只允許 `https://`，並經過 Pikara Secure Network：DoH、TLS ≥ 1.2、只允許該主機的白名單。
  - `http://` 只允許 127.0.0.1／localhost（開發用）。

### UI
- 沿用 CYW 品牌：深色介面、金色 #f5b301、Noto Sans TC，以及既有的按鈕、徽章、卡片、對話框元件。
- 動畫：沿用 `src/motion` 的頁面轉場、列表進場與對話框。投票按鈕只對 transform 和顏色做 120 ms 的轉場，沒有持續執行的動畫。尊重「減少動態效果」與「關閉動畫」設定。

## 本機執行

後端（另見 `services/feedback/README.md`）：
```powershell
cd services/feedback; npm ci; npm run dev
```
CYW 指向本機後端：
```powershell
$env:PIKARA_CYW_FEEDBACK_API = "http://127.0.0.1:8787"
```
本機開發用的後端提供「本機開發登入」，可以不經 GitHub 以任意角色登入。正式環境（`ENVIRONMENT=production`）中這個端點會回傳 404。

## 部署前需要你批准的事項（都尚未執行）
1. 建立 Cloudflare 帳號／Worker、D1 資料庫與 R2 bucket（免費方案即可），並套用 `migrations/`。
2. 建立 GitHub OAuth App（只需 Client ID，開啟 Device Flow），把 Client ID 填入 `wrangler.toml`。
3. 建立同步用的 GitHub Token（建議用 fine-grained Token 或 GitHub App，只開 Issues 讀寫），並以 `wrangler secret put GITHUB_TOKEN` 存入 Worker。
4. 設定 `GITHUB_WEBHOOK_SECRET`，並在各 repo 新增 Webhook（issues、issue_comment、release）。這屬於 repo 設定變更。
5. 在 `MAINTAINER_LOGINS` 填入維護者帳號。
6. 以 `CYW_FEEDBACK_API=https://<worker 網址>` 建置 CYW，或讓使用者設定 `PIKARA_CYW_FEEDBACK_API`。
