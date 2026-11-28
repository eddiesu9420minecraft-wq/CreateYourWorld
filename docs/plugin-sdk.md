# Pikara Plugin SDK 與 manifest 規範（schema 1）

適用於所有由 Create Your World 管理的軟體：PikaraScienceStudio、runX，以及未來的 RunXStudio、RunXIDE。實作：`crates/cyw-core/src/plugins.rs`；範例：runX 倉庫的 `plugins.json`。

## 1. 發布者要提供的東西

1. **外掛套件**：`.zip` 或 `.tar.gz`，放在軟體的 GitHub Release（只接受 Create Your World 允許的 GitHub HTTPS 網址）。套件根目錄放 `plugin.json`：
   ```json
   { "schema": 1, "software": "runX", "id": "runX-Examples", "version": "1.1.0", "permissions": ["files:plugin"] }
   ```
2. **外掛索引** `plugins.json`，放在軟體倉庫（產品目錄的 `pluginIndex` 指向它），並以 Pikara 發布金鑰簽章，產生 `plugins.json.sig`：
   ```json
   {
     "schema": 1,
     "software": "runX",
     "plugins": [
       {
         "id": "runX-Tutorial",
         "name": "runX 語法教學",
         "description": "…",
         "versions": [
           {
             "version": "1.0.0",
             "url": "https://github.com/<owner>/<repo>/releases/download/<tag>/runX-plugin-Tutorial-1.0.0.zip",
             "sha256": "<64 hex>",
             "size": 8181,
             "requires": ">=0.1.0-alpha",
             "dependencies": { "runX-Examples": "^1.1" },
             "conflicts": [],
             "permissions": ["files:plugin"],
             "scripts": []
           }
         ]
       }
     ]
   }
   ```
   在倉庫的 `.gitattributes` 把 `plugins.json` 與 `*.sig` 設為 `-text`，換行字元才不會改變簽章過的內容。

## 2. 欄位

| 欄位 | 規則 |
| --- | --- |
| `schema` | 目前為 `1` |
| `software` | 主程式的完整產品名稱；必須等於產品目錄的 ID，否則整份索引被拒絕 |
| `id` | 外掛識別名稱：英數與 `. - _`，最長 64，不可以 `.` 開頭或包含 `..`；同一份索引內不分大小寫唯一。建議以軟體名稱開頭（`runX-Examples`） |
| `version` | SemVer |
| `url` | HTTPS，且主機在 Create Your World 的 GitHub 允許清單內 |
| `sha256` / `size` | 套件的 SHA-256 與位元組數；下載後兩者都必須相符 |
| `requires` | 對主程式已安裝版本的 SemVer 範圍；主程式未安裝或版本不符時不會安裝 |
| `dependencies` | 同一軟體的其他外掛：ID → SemVer 範圍 |
| `conflicts` | 不能同時啟用的外掛 ID |
| `permissions` | 宣告需要的權限（見下表）；未知的權限使整份索引無效 |
| `scripts` | 宣告的安裝腳本；**Create Your World 永遠不會執行**，只會告知使用者 |

不認得的欄位會讓整份索引被拒絕（防止夾帶 `postInstall` 之類的指令）。

### 權限

| 權限 | 意義 |
| --- | --- |
| `files:plugin` | 讀寫自己的外掛資料夾（預設，不需確認） |
| `files:project` | 讀寫使用者目前開啟的專案 |
| `files:user` | 讀寫使用者選擇的檔案 |
| `network` | 連線到網路 |
| `gpu` | 使用 GPU |
| `process` | 啟動其他程式 |

`files:plugin` 以外的權限在安裝前需要使用者同意（非互動式：`--yes`）。沒有任何權限可以取得系統管理員權限。**權限由主程式負責執行**：外掛宣告了什麼，主程式就只給什麼。

## 3. 安裝流程與安全

1. 下載 `plugins.json` 與 `.sig`（DoH、只走 HTTPS、主機允許清單、檢查重新導向）。
2. 以編譯進 CYW 的 Pikara 公鑰驗證簽章 → 解析 → 驗證每個欄位。任一步失敗就拒絕整份索引。
3. 解析版本、相依（先裝相依）、相容性、衝突、循環；已啟用外掛需要的版本不會被降級。`--dry-run` 到此為止。
4. 下載每個套件，大小與 SHA-256 必須符合簽章過的索引；不符就刪除檔案。
5. 用防路徑穿越的解壓縮器解到暫存資料夾，再移到 `<資料夾>/plugins/<軟體>/<外掛>/<版本>/`；任何失敗都會刪除暫存與本次已解出的版本，原有版本不受影響。
6. 在跨程序鎖內更新共用資料庫 `<資料夾>/plugins.json`，並寫出 `<資料夾>/plugins/<軟體>/enabled.json`。

## 4. 主程式要做的事

主程式在啟動時讀取 `enabled.json`：

```json
{ "schema": 1, "software": "runX",
  "plugins": [ { "id": "runX-Examples", "version": "1.1.0", "dir": "…/plugins/runX/runX-Examples/1.1.0", "permissions": ["files:plugin"] } ] }
```

- 只載入列出的外掛、只從 `dir` 讀取。
- 依 `permissions` 限制外掛能做的事。
- 不執行外掛內的任何腳本，除非主程式自己的設計有明確、經使用者同意的機制。
- 資料夾位置：Windows `%LOCALAPPDATA%\com.pikara.cyw`、macOS `~/Library/Application Support/com.pikara.cyw`、Linux `~/.local/share/com.pikara.cyw`。

## 5. 目前狀態

- runX 已發布真實的簽章索引，包含 `runX-Examples`（1.0.0、1.1.0）與 `runX-Tutorial`（1.0.0，相依 `runX-Examples ^1.1`）。
- PikaraScienceStudio 尚未發布外掛索引（`cyw -m PikaraScienceStudio list plugins` 會說明不支援）。
- CYW 視窗尚未有外掛頁面；外掛目前以 `cyw` 管理，資料庫與視窗共用。
