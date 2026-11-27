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

## 尚未測試
- macOS（ARM64 / Intel）的所有平台專屬程式碼：DMG 掛載、`.app` 啟動、Metal 與 Rosetta 偵測。
- Linux。
- GitHub Actions workflow 尚未在 GitHub 上執行。
