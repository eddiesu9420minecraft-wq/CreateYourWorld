# cyw 命令列使用手冊

`cyw` 是 Create Your World 的命令列版本（Windows：`cyw.exe`；macOS／Linux：`cyw`）。它和 CYW 視窗共用同一套 Rust 核心（`crates/cyw-core`）：同一個產品目錄、已安裝軟體資料庫、設定、安裝資料夾、下載驗證（SHA-256、GitHub digest、Pikara 數位簽章）、DoH 安全連線、回復與自我更新。`cyw` 不需要視窗、WebView 或 Node.js，可以在 SSH、無桌面環境與 CI 中使用。

安裝 CYW 時，安裝程式會詢問是否把 `cyw` 加入**使用者** PATH（不需要系統管理員權限；解除安裝時自動移除）。

## 套件名稱

每個軟體只有一個名稱：**完整產品名稱**，不分大小寫，沒有別名。

| 套件 | 類型 |
| --- | --- |
| `PikaraScienceStudio` | 應用程式 |
| `runX` | 開發工具（命令列） |
| `RunXStudio`、`RunXIDE` | 保留給未來的產品 |

`studio`、`pikarastudio`、`pss` 這類通用別名一律不接受（結束碼 3），以免全家桶擴充後撞名。舊版 CYW 使用的識別碼（例如 `pikara-science-studio`）只用來**自動遷移**既有的安裝紀錄、頻道設定與下載紀錄：不會重新下載、不會搬移安裝資料夾、不會刪除任何使用者資料。

## 指令

| 指令 | 說明 |
| --- | --- |
| `cyw -V` / `cyw -h` | 版本 / 說明 |
| `cyw list software`（`cyw -m list software`） | 所有軟體、最新版本、安裝狀態 |
| `cyw list installed` | 已安裝的軟體與保留的舊版本 |
| `cyw download <套件> [--version <版本>] [--dry-run]` | 下載、驗證、安裝（已有該版本時直接切換，不重新下載） |
| `cyw update <套件>` / `cyw update --all` | 更新 |
| `cyw run <套件> [--wait\|--detach] [-- <參數…>]` | 啟動；`cyw /run <套件>`、`cyw -r <套件>` 相同 |
| `cyw remove <套件>` | 解除安裝（軟體自己的使用者資料一律保留；沒有終端機時需要 `--yes`） |
| `cyw rollback <套件>` | 回到上一個保留的版本 |
| `cyw path add\|remove <套件>` | 把命令列工具加入／移出使用者 PATH |
| `cyw info <套件>` | 詳細資料 |
| `cyw doctor` | 檢查資料夾、跨程序鎖、產品目錄、已安裝檔案、簽章金鑰、DoH、GitHub API、PATH |
| `cyw self update [版本]`（`cyw -m update [版本]`） | 更新 Create Your World 本身 |
| `cyw self versions`（`cyw -m list V`） | 目前、最新與已發布的版本 |
| `cyw completions powershell\|bash\|zsh` | 自動補全腳本 |
| `cyw -m <套件> …` | 外掛管理（見下方） |

### 啟動（run）

- 從本機套件資料庫找出目前版本的執行檔，**不經過 Shell**：程式與每個參數分開傳遞，`--` 之後的內容原封不動交給程式。`.bat`、`.cmd`、`.ps1`、`.sh` 等腳本一律拒絕。
- 命令列工具（例如 runX）以及**帶參數**啟動的程式：繼承 stdin／stdout／stderr，`cyw` 的結束碼就是程式的結束碼。
- 沒有參數的 GUI 軟體：直接在背景啟動，立即返回（終端機或 SSH 不會被卡住）。`--wait` / `--detach` 可以覆寫。
- 未安裝：互動式終端機會詢問是否下載；非互動式（SSH 指令、CI）只提示 `cyw download <套件>` 並以結束碼 3 結束（`--yes` 會直接下載再啟動）。

```powershell
cyw /run PikaraScienceStudio
cyw /run PikaraScienceStudio -- --cli build-info
cyw run runX -- main.rux -o main.exe
```

### 自我更新

只會安裝簽署過的 `update.json` 所列的最新版本：簽章、SHA-256、防降級、防重送全部檢查，不能指定較舊或未簽署的版本。下載驗證後由暫存的更新程式在 `cyw` 結束後安裝；安裝失敗會自動還原舊版，紀錄在 `<資料夾>/self-update/helper.log`。CYW 視窗正在執行時會拒絕更新（結束碼 6），因為安裝程式需要替換它的檔案。開發版本不會自我更新。

## 外掛

```text
cyw -m <軟體> list plugins
cyw -m <軟體> list installed
cyw -m <軟體> download <外掛> -- install        （`--install` 相同）
cyw download <外掛> --install                    （自動找出所屬軟體；多個軟體有同名外掛時要求用 -m 指定）
cyw -m <軟體> update <外掛>  |  update --all
cyw -m <軟體> remove <外掛>
cyw -m <軟體> enable|disable|rollback <外掛>
```

- 安裝前檢查與已安裝軟體版本的相容性、自動安裝相依外掛（先裝相依）、檢查衝突與循環相依；已啟用的外掛所需要的版本不會被降級或回復掉。
- `--version <版本>` 指定版本；`--dry-run` 只列出計畫。
- 需要 `files:plugin` 以外權限的外掛會先詢問；非互動式要加 `--yes`。
- CYW 不會執行外掛的任何腳本。
- 規格：[plugin-sdk.md](plugin-sdk.md)。

## 全域選項

| 選項 | 說明 |
| --- | --- |
| `--json` | stdout 只輸出一份 JSON（含 `ok`；錯誤時含 `code` 與 `error`），適合腳本與 AI Agent |
| `-q, --quiet` | 只顯示錯誤 |
| `-v, --verbose` | 顯示更多細節 |
| `-y, --yes` | 同意所有確認（非互動式使用必須） |
| `--lang zh-TW\|zh-CN\|en` | 語言；預設依 `CYW_LANG`、系統語系，否則繁體中文（核心的錯誤訊息為繁體中文） |

訊息輸出到 stderr，格式 `[ HH:MM:SSZ ] 等級 訊息`（UTC）。只有 stderr 是終端機時才使用色彩與進度條（`NO_COLOR`、`FORCE_COLOR` 有效）；沒有終端機時（SSH 指令、CI、重新導向到檔案）每 10% 輸出一行純文字，不會有重繪字元。

## 結束碼

| 碼 | 意義 |
| --- | --- |
| 0 | 成功（`run` 時為程式本身的結束碼） |
| 1 | 一般錯誤 |
| 2 | 用法錯誤，或需要 `--yes` 確認 |
| 3 | 找不到套件、外掛，或尚未安裝 |
| 4 | 安全驗證失敗（簽章、SHA-256、降級、索引不受信任） |
| 5 | 網路錯誤 |
| 6 | 忙碌中（另一個 CYW 程序正在安裝同一個套件、軟體正在執行、CYW 視窗正在執行） |

## 與 CYW 視窗同時使用

已安裝資料庫、設定與外掛資料庫的每一次修改都在跨程序檔案鎖（`<資料夾>/.state.lock`）內，從磁碟讀取最新內容、修改、以原子方式取代；同一個套件同時只能有一個程序在安裝（`<資料夾>/locks/`）。視窗會在檔案變更後重新讀取，所以 `cyw` 安裝的軟體會出現在視窗裡，反之亦然。

## 環境變數

| 變數 | 用途 |
| --- | --- |
| `CYW_LANG` | 預設語言 |
| `NO_COLOR` / `FORCE_COLOR` | 色彩 |
| `GITHUB_TOKEN` / `GH_TOKEN` | 提高 GitHub API 速率限制（只送往 GitHub API） |
| `PIKARA_CYW_DATA_DIR` | **測試專用**：使用獨立的資料夾 |
| `PIKARA_CYW_ENV_KEY` | **測試專用**：PATH 改寫到這個 HKCU 機碼，不碰真正的 PATH |

## 自動補全

```powershell
cyw completions powershell | Out-String | Invoke-Expression
```

```bash
cyw completions bash > ~/.local/share/bash-completion/completions/cyw
cyw completions zsh > "${fpath[1]}/_cyw"
```
