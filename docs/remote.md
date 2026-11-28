# Core + CLI + GUI 與 SSH 遠端操作（全家桶長期架構）

## 原則

每個 Pikara 軟體都分成三層：

| 層 | 內容 | CYW | PikaraScienceStudio | RunX / RunXIDE |
| --- | --- | --- | --- | --- |
| Core | 所有會改變資料或系統的邏輯，純 Rust，不依賴視窗 | `crates/cyw-core` | Studio 的 Rust 核心（佇列、資料庫、製作流程） | 編譯器 `runxc`、未來的 LSP／除錯器 |
| CLI | 非互動、可腳本化、`--json` | `cyw` | `PikaraScienceStudio.exe --cli …` | `runxc` |
| GUI | 只負責顯示與操作，呼叫同一個 Core | Tauri 視窗 | Tauri 視窗 | 未來的 RunXIDE |

GUI 與 CLI 共用 Core、資料庫與任務佇列；任何功能都要能在 CLI 完成，GUI 不能有 CLI 做不到的事。

## SSH 遠端

- **安全通道**：只使用 SSH（Windows OpenSSH、macOS、Linux 內建）。不預設開放任何額外的網路埠，也沒有自訂的遠端協定或 HTTP 服務。
- **不需要桌面**：CLI 不建立視窗、不需要 WebView、不依賴 Windows 桌面工作階段（session 0 / 服務環境也能執行）。
- **非互動**：所有確認都可用 `--yes` 回答；沒有 TTY 時絕不等待輸入。
- **TTY 偵測**：只有 stderr 是終端機時才顯示進度條與色彩；`ssh host cyw …`（沒有配置 TTY）只輸出純文字行，不會有重繪字元弄亂遠端日誌。
- **機器可讀**：`--json` 在 stdout 輸出單一 JSON 文件，結束碼有固定意義（見 [cli.md](cli.md)）。
- **併發安全**：GUI、本機 CLI、多個 SSH 工作階段同時操作時，以跨程序檔案鎖保護共用資料庫。

## 長時間任務與斷線

SSH 斷線時，該工作階段的程序可能被結束（Windows OpenSSH 以 Job Object 管理工作階段程序）。因此長時間工作（影片製作、批次渲染）**一律提交到佇列，由獨立的 Worker 執行**：

1. 提交：`PikaraScienceStudio.exe --cli auto-start …`（或 `enqueue`）只把任務寫進 Studio 的資料庫就結束。
2. 執行：Worker（`--cli run-queue` / `auto-run --stay`）從資料庫領取任務；它的心跳、進度與日誌都寫回資料庫。Worker 中斷後，下一個 Worker 會依心跳接手（已完成的配音、渲染片段有快取，不重做）。
3. 重新連線後：`--cli auto-board` / `auto-status` / `job-log` 查看進度；`auto-pause` / `auto-resume` / `auto-stop` 控制。

Worker 必須在 SSH 工作階段之外存活，方式依平台：

| 平台 | 方式 |
| --- | --- |
| Windows | 以「工作排程器」的使用者工作（登入時或依需求啟動，不需系統管理員）執行 Worker；或由 CYW 視窗擁有 Worker。Worker 不在 SSH 的 Job Object 內，所以斷線不影響 |
| macOS | `launchd` 使用者 LaunchAgent |
| Linux | `systemd --user` 服務（需要 `loginctl enable-linger`）或 `nohup`/`setsid` |

`cyw run <套件> --detach` 在 Windows 以 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`、在 Unix 以新的行程群組啟動，不受終端機關閉影響；**能否脫離 SSH 的 Job Object 尚未在實際 SSH 環境驗證**，在驗證之前，長時間任務請使用上表的 Worker 方式。

## RunXIDE 的 Remote Development（預留）

本機 IDE 只負責畫面；編譯器、LSP、除錯器與檔案系統在遠端機器上執行：

- 連線：IDE 透過 SSH 啟動遠端的 `runxc lsp --stdio`、`runxc debug --stdio`（未來的子指令），資料走 SSH 通道的 stdin／stdout（LSP JSON-RPC、DAP），不開任何連接埠。
- 檔案：透過同一條 SSH 連線的 SFTP 子系統存取，或由遠端 `runxc` 提供的檔案操作（列表、讀寫、監看）。
- 安裝：遠端用 `cyw download runX` 安裝相同版本的 runxc；IDE 以 `cyw --json list installed` 確認版本相符。
- 安全：認證完全交給 SSH（金鑰）；IDE 不保存密碼。

## 驗證狀態

| 項目 | 狀態 |
| --- | --- |
| 非互動、`--json`、結束碼、TTY 偵測、無視窗執行 | 已實作並以整合測試驗證（非 TTY 輸出不含 `\r` 與 ANSI） |
| GUI／CLI 同時操作的資料庫安全 | 已驗證（跨程序鎖、同時安裝同一套件時第二個程序得到結束碼 6） |
| 實際 SSH 登入、斷線重連、Worker 跨斷線持續執行 | **尚未測試**：需要可以登入的 SSH 主機（本機 Windows OpenSSH Server 或 Mac） |
