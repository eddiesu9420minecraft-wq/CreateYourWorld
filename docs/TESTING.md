# 測試紀錄

只記錄實際執行過的測試與實際結果。未測試的項目另列。

## 2026-11-27 · Windows 11 x64（開發機）

測試方式：以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port` 啟動 CYW，透過 Chrome DevTools Protocol 呼叫實際的 Tauri 指令、讀取畫面並截圖（腳本在 `tools/test/`）。

### 自動化測試
- `cargo test`：10 項通過（版本頻道分類、SemVer 排序、資產選擇、SHA256SUMS 解析、路徑穿越防護、符號連結檢查、安裝失敗回復）。
- `tsc --noEmit` 與 `vite build`：通過。

### GitHub 版本查詢
- 取得 Pikara Science Studio 的真實 release：v0.3.1、v0.3.0（stable），以及 v0.2.1-alpha 等預先發布版。
- Windows x64 選中 `PikaraScienceStudio.exe`（portable）。macOS 沒有對應檔案，顯示「此平台尚無版本」。

### 下載、斷點續傳、驗證
- 安裝 v0.3.0：下載到 5,617,024 bytes 時暫停，續傳時伺服器以 `Range` 從 5,698,944 bytes 繼續，最終 20,468,224 / 20,468,224 bytes。
- SHA-256 `7c2208a1ad79c5c30d0290d0b0984066e933110ef065532e988d8ad0582e98ff`：與 GitHub digest、SHA256SUMS 都相符。
- 發布簽章：Studio 的 release 沒有附 `.sig`，顯示「尚未設定發布簽章公鑰」。

### 更新、回復、切換、解除安裝
- 更新到 v0.3.1 後保留 v0.3.0；回復至 v0.3.0；再「更新」至 v0.3.1 時直接切換到已保留的版本（`jobId: null, switchedTo: v0.3.1`），不重新下載。
- 解除安裝後 `apps/` 為空，`downloads/` 沒有殘留的 `.part` 檔。

### 啟動畫面
- 發現並修正兩個問題：
  - 後端先完成時，ready 訊號遺失：`watch::send` 在沒有接收者時會丟棄值，改用 `send_replace`。
  - 隱藏視窗中 `setTimeout` 被節流，改用 `useLayoutEffect`。
- 修正後實測（從程序啟動起算）：debug 版後端完成 435 ms、主視窗就緒 582 ms；release 版 533 ms / 662 ms。轉場立即開始，splash 會自行關閉。

### 啟動 Studio
- 第一次：CYW 成功啟動 Studio，但 Studio 因既有的 `studio.db` 損毀而結束。
- 資料庫修復後（另行處理，保留所有原始檔案）：透過 CYW 安裝 v0.3.1 並啟動，Studio 持續執行超過 15 秒，自行完成資料庫 v2 → v3 升級，`quick_check` 為 ok。

### 安裝檔
- `tauri build` 產生 NSIS `Create Your World_0.1.0_x64-setup.exe`（17.34 MiB）與 MSI（18.20 MiB）。

## 2026-11-27（下午）· Pikara Secure Network 與更新安全

### pikara-secure：離線攻擊測試（`cargo test`，12 項全數通過）
測試資料由 `tools/gen-secure-fixtures.sh` 以一次性的測試金鑰產生；這些測試金鑰的私鑰在產生後即刪除。
- 偽造的 update.json（用攻擊者金鑰簽章）→ 拒絕
- 竄改已簽章的 update.json（改掉 SHA-256 或版本號的一個字元）→ 拒絕
- 空白或格式錯誤的簽章 → 拒絕；內建的正式公鑰不接受測試金鑰的簽章
- 惡意降級（0.0.9 → 拒絕）；重放較舊的 manifest（版本或發布時間倒退 → 拒絕）
- 更新包網址綁定版本：其他版本的 tag、`http://`、仿冒的網域 → 拒絕；其他產品的 manifest → 拒絕
- 安裝包翻轉 1 個位元 → SHA-256 不符，拒絕；攻擊者連同 SHA-256 一起改掉 → 簽章不符，拒絕；用錯誤金鑰簽章 → 拒絕

### pikara-secure：連網測試（7 項全數通過）
- DoH：`api.github.com` 經 Cloudflare 解析，第二次查詢命中快取
- 第一個 DoH 服務故障（bootstrap 指向不可路由的 192.0.2.1）→ 自動切換到 Google
- 所有 DoH 服務都故障 → 回報錯誤，不退回系統 DNS；不存在的網域 → 回報錯誤
- 無效的 TLS 憑證（badssl.com）：過期、自簽、主機名稱不符、不受信任的根憑證 → 全部拒絕；有效憑證的對照組可正常連線
- `http://` → 拒絕；重新導向到不在允許清單的主機（codeload.github.com）→ 拒絕

### 已簽章的正式安裝包（本機建置，使用真正的 Pikara 發布金鑰）
- `Create Your World_0.1.0-alpha_x64-setup.exe` 的 `.sig` 以程式內建的公鑰驗證通過。
- `create-your-world.exe --pikara-version` 輸出 `0.1.0-alpha`。

### 重要發現：Claude 桌面 App 的檔案虛擬化
- Claude 桌面 App 是封裝的 Windows App。由它啟動的程序（包括 WSL interop）寫入 AppData 時，部分寫入會被重新導向到 `AppData\Local\Packages\Claude_…\LocalCache`，只有在該容器內才看得到。
- 後果：前一次修復時移出的原始 WAL / SHM / 舊 db、恢復資料夾，以及當時在容器內啟動的 Studio 所寫入的 WAL，都只存在於容器內。
- 已處理：恢復資料夾已複製到真實磁碟的 `%APPDATA%\PikaraScienceStudio-recovery`（195 個檔案，雜湊相符）；容器內殘留的 Studio WAL/SHM 先備份再移除，以免日後被套用到已變動的資料庫上。
- 推測（尚未證實）：Studio 原本的資料庫損壞，可能也是同一種情況造成的——同一份資料庫曾分別在容器內（Claude 工作階段）與容器外執行，導致主檔與 WAL 不一致。

### 在容器外的真實環境測試（透過 Explorer 啟動，確認寫入真實磁碟）
- 以 `/S` 靜默安裝 CYW 0.1.0-alpha 到 `%LOCALAPPDATA%\Create Your World`。
- 啟動後：splash → 主視窗 1,241 ms（首次啟動，快取是空的）；自身更新狀態為「可自動更新的安裝版」；查詢 update.json 得到 HTTP 404（尚未發布，如實回報為網路錯誤，不是安全警示）；DoH 經 Cloudflare 解析。
- 由 CYW 安裝 Studio v0.3.1（SHA-256 與 GitHub digest、SHA256SUMS 都相符）並啟動：Studio 持續執行，在真實位置完成資料庫備份與 v2 → v3 升級，`integrity_check` 為 ok，8 個製作、141 個工作完整保留。

## 尚未測試
- macOS 實機（DMG 掛載、`.app` 啟動與自身更新、Metal 與 Rosetta 偵測）、Linux、GitHub Actions（等待 `workflow` 權限）、跨版本自動更新（需要先發布 v0.1.0-alpha 與下一個版本）、DNS 遭竄改測試（在 CI 執行）。

## 2026-11-27（晚上）· 發布與真實跨版本更新

### CI（GitHub Actions，全部實際執行）
- `ci`：Windows、macOS ARM64（`macos-15`）、macOS Intel（`macos-15-intel`）、Linux 共 8 個 job 全部通過，包含 pikara-secure 的連網安全測試。
- `dns-tamper`：在 4 個平台上把 hosts 檔中的 GitHub 網域指向 `10.255.255.1`。系統 DNS 確實被竄改（例如 `api.github.com → 10.255.255.1`），使用系統 DNS 的用戶端連線失敗；Pikara Secure Network 經 Cloudflare DoH 取得真實 IP，HTTPS 驗證通過。
- macOS 的 `macos-14` runner 已停用（job 一直沒被分配到 runner），已改用 `macos-15` 與 `macos-15-intel`。

### 發布
- v0.1.0-alpha、v0.1.1-alpha、v0.1.2-alpha 都由 `release.yml` 發布。每個版本都有 Windows NSIS、macOS ARM64 / x64 的 `.app.tar.gz`（附 `.sig`）與 DMG，以及 `SHA256SUMS.txt`；`update.json` 在所有檔案上傳完成並發布後才提交。
- 冒煙測試：3 個平台的正式 binary 都在 GitHub 的對應 runner 上實際執行 `--pikara-version` 並輸出正確版本。**這是 GitHub 的虛擬 Mac，不是 Mac 實機。**
- 第一次發布時，macOS 因 `APPLE_CERTIFICATE` 是空值而簽章失敗；已修正為未設定時不傳入。
- 另以本機獨立驗證已發布的 v0.1.0-alpha：raw `update.json` 以內建公鑰驗證通過（3 個平台），`SHA256SUMS.txt` 相符，Windows 安裝包簽章有效。

### 真實跨版本更新（Windows 11，容器外的真實安裝，看不見的桌面）
- 測試程序改在看不見的 Windows 桌面上執行（`tools/test/hidden-desktop/`）：不顯示視窗、不搶焦點（每一步都檢查前景視窗，都還是使用者原本的視窗）；安裝程式一律使用 `/S` 靜默模式。
- 已安裝的 CI 版 v0.1.0-alpha 啟動後，自動經 DoH 取得並驗證 `update.json`，發現 0.1.1-alpha；防重放狀態寫在真實磁碟上。
- **竄改測試**：下載到 10.5/18.2 MB 時暫停，經 WSL 在真實磁碟上改掉 `.part` 檔中的 8 個位元組，再續傳（從 10,564,207 bytes 繼續）→ SHA-256 不符，拒絕安裝、刪除檔案、標示安全警示；已安裝的版本仍是 0.1.0-alpha。
- **正常更新 0.1.0-alpha → 0.1.1-alpha**：SHA-256 與發布簽章皆通過 → 輔助程序備份 → 靜默安裝（exit 0）→ 新 binary 回報 0.1.1-alpha → 移除備份。`installed.json` 的雜湊在更新前後完全相同（使用者資料保留）。
- **正常更新 0.1.1-alpha → 0.1.2-alpha**：同樣成功。
- **發現的問題**：兩次更新後，舊版輔助程序都沒有成功重新啟動 CYW（沒有當機紀錄）。v0.1.2-alpha 的輔助程序改為確認新程序持續執行，否則重試並記錄。以 v0.1.2 的輔助程序實際重新安裝 v0.1.2 並重新啟動：`relaunched (attempt 1), pid 9992 is running`，重新啟動後狀態為 0.1.2-alpha「已是最新版本」。這次測試沒有重現「舊版程序尚未完全結束」的情況，所以要等下一次真實更新（0.1.2 → 0.1.3）才能完整確認問題已解決。
- 測試結束後已關閉所有 CYW 測試程序；使用者正在使用的 Studio（PID 21324）從頭到尾都沒有被動到。

### 尚未測試
- macOS 實機（DMG、`.app` 自身更新、Metal 與 Rosetta 偵測）。
- 下一次真實更新時的重新啟動（0.1.2 → 0.1.3）。
- P4 共用運行環境（尚未實作）。

## 2026-11-27（夜間）· UI 動畫系統

實作：`src/motion/`（統一的動畫參數與可重用元件，使用 Motion 搭配 LazyMotion；動畫功能另外拆成非同步 chunk）、`src/styles/motion.css`（Hover、點擊回饋、進度條、減少動態效果）。設定新增「介面動畫」：跟隨系統／開啟／關閉。

測試方式：`tools/test/ui-motion.mjs`，透過 CDP 對看不見桌面上的測試程序（`launch-hidden.ps1`）量測。WebView2 使用獨立的資料夾（`WEBVIEW2_USER_DATA_FOLDER`）；隔離回歸測試另外設定 `PIKARA_CYW_DATA_DIR`。看不見的桌面上 rAF 不會被節流（實測 16.7 ms/幀），所以 FPS 數據是有效的。

- 26/26 項檢查全部通過（在全新的測試程序上連續執行 2 次），原始數據在 `docs/ui-motion-report.json`：
  - 7 個頁面都能正常顯示，側邊欄指示器跟著選取的項目移動。
  - 頁面切換與 Modal 只對 `transform`/`opacity`（以及 Hover 顏色）做動畫。
  - Modal 先播完退出動畫再移除；Toast 依類型停留 4 秒或 8 秒，退出後移除。
  - 進度條以 `transform: scaleX` 驅動，不再對 width 做動畫。
  - 「關閉動畫」時，沒有任何超過 1 ms 的動畫；設定可以正確還原。
  - 沒有 JS 錯誤或 console 錯誤。
- 頁面切換：7 個頁面平均都是 16.7 ms/幀，最差 16.9 ms（60 FPS）。第一版建置的第一次切換曾出現一個 266 ms 的幀，但改版後連續 2 次都沒有重現。
- 閒置 10 秒：執行中的動畫為 0，主執行緒工作只有 15.7–18.8 ms（約 0.2%）。
- Bundle：主程式 JS 從 178 KB 增加到 227 KB（gzip 58 → 75.6 KB），Motion 的功能另外放在 84 KB 的非同步 chunk；啟動畫面頁面不包含 Motion。
- 功能回歸（隔離的資料目錄 `PIKARA_CYW_DATA_DIR`）：安裝 Studio v0.3.1 時 GitHub digest 與 SHA256SUMS 都通過、進度條 `scaleX(0 → 0.85)`、清除快取成功、解除安裝成功。Rust 測試 10/10 通過。
- 發現：測試程序若在 Claude 容器內執行且沒有設定 `PIKARA_CYW_DATA_DIR`，仍然會讀到（而且可能寫入）使用者真實的 `installed.json`；在容器內清除快取也會遇到「重新分析點」錯誤，這是容器虛擬化造成的，在 D: 槽的隔離目錄中正常。因此測試一律使用隔離的資料目錄。確認過使用者真實的 settings.json 沒有被測試改動。
- 尚未測試：macOS（Apple Silicon、Intel）實機上的動畫表現；Windows 上可見視窗的主觀流暢度（依使用者要求，本次沒有開啟可見視窗）。

## 2026-11-28 runX 整合（開發工具分類、PATH）

變更：
- 產品目錄新增 `category`（`app` / `devtool`）、`cli`（命令列工具的執行檔名稱）、`defaultChannel`。
- 新增 runX（`eddiesu9420minecraft-wq/runX`），預設 Alpha 頻道，**必須**有 Pikara 發布金鑰簽章。
- 新增「加入 PATH」：
  - 目前版本的 `runxc.exe` 會複製到 `<資料夾>\bin`，並把這個資料夾加入 `HKCU\Environment\Path`（只寫使用者層級，不需要系統管理員權限），然後廣播 `WM_SETTINGCHANGE`。
  - 每次 `installed.json` 變更（安裝、更新、切換、回復、解除安裝）以及 CYW 啟動時都會同步；沒有工具需要時，會移除 PATH 項目。
- 命令列工具不提供「開啟」，按了會說明用法。
- 「所有應用程式」新增「全部／應用程式／開發工具」分頁。

測試：
- Rust 單元測試 12/12 通過。`cli_path::sync_cycle_uses_a_test_registry_key` 驗證以下流程，全程只寫入測試用登錄機碼，測試後刪除：加入 PATH → 更新後副本跟著換 → 移除後副本與 PATH 項目都清掉。
- 隔離的 CYW 在隱藏桌面執行，搭配 `PIKARA_CYW_DATA_DIR` 與 `PIKARA_CYW_ENV_KEY`，結果 **18/18 通過**。報告：`D:\t\cyw-runx\report.json`；runX 倉庫 `docs/test-report-v0.1.0-alpha.md` 有逐項說明。
  - 第一次執行時，測試腳本在 Claude 容器內讀取 HKCU，看不到 CYW（在容器外）寫入的值，造成誤判 PATH 沒有寫入。改從容器外執行整個測試腳本後才是真實結果，這不是 CYW 的問題。
- 清理：測試登錄機碼已刪除。使用者真實的 `HKCU\Environment\Path` 中沒有任何 CYW 項目。使用者正在執行的 CYW 與 Studio v0.3.4 沒有被關閉。
- 未測試：
  - 使用者真實 PATH 的寫入：程式碼路徑相同，只是換了機碼名稱。
  - macOS／Linux 的 `~/.local/bin` 符號連結。
  - 本次沒有發布新版 CYW：使用者目前的 CYW v0.1.2-alpha 不含這些功能。
