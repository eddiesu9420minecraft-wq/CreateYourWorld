# Create Your World.（CYW）

**Create Your World. · Free Forever. — by pikara™**

Pikara 全家桶的官方軟體管理中心。永遠免費、無訂閱、無付費解鎖、無強制廣告。

技術：Rust + Tauri 2、React + TypeScript、Vite。所有平台共用同一套前端與核心邏輯；路徑一律由 Tauri path API 依作業系統決定，沒有硬編碼的 Windows 路徑。

## 授權

MIT License，見 [LICENSE](LICENSE)。

## 開發

```powershell
npm install
npm run tauri dev
```

```powershell
npm run tauri build
```

`cargo test --manifest-path src-tauri/Cargo.toml` 執行 Rust 單元測試（版本頻道、資產選擇、校驗檔解析、安全解壓縮、安裝失敗回復）。

> 若專案放在很深的路徑下，MSVC 連結器可能因超過 260 字元失敗（LNK1104）。設定較短的 `CARGO_TARGET_DIR` 即可。

## 架構

| 模組 | 說明 |
|---|---|
| `src-tauri/catalog/products.json` | 產品清單：GitHub repo、各平台的資產比對規則、可選的 minisign 公鑰 |
| `github.rs` | Releases API、ETag 條件請求、10 分鐘快取、速率限制（`x-ratelimit-*` / `retry-after`）處理；失敗時退回快取並顯示警告 |
| `platform.rs` | OS / CPU 偵測（含 macOS Rosetta），依清單規則或推測法挑選正確的檔案 |
| `downloads.rs` | 下載佇列、並行數、`Range` 斷點續傳（重開程式後仍可續傳）、暫停 / 取消 / 重試 |
| `verify.rs` | SHA-256：比對 GitHub `digest` 與 `SHA256SUMS`；minisign / Tauri `.sig` 簽章驗證 |
| `archive.rs` | 安全解壓縮：拒絕絕對路徑、`..`、指向外部的符號連結、硬連結；大小與項目數上限 |
| `install.rs` | 每個版本獨立目錄；先在 staging 完成再原子性換入，失敗時舊版本完全不受影響 |
| `hub.rs` | 產品檢視、更新判斷、回復、解除安裝、啟動 |
| `runtime.rs` | CUDA / AMD / Metal / CPU 後端偵測 |
| `crates/pikara-secure` | **Pikara Secure Network**，所有 Pikara 軟體共用：DoH 解析、HTTPS 限定的用戶端、已簽章 update.json 的驗證、串流計算 SHA-256 與 minisign 驗證、內建的信任公鑰 |
| `selfupdate.rs` | CYW 自身更新：已簽章的 update.json → 透過下載佇列下載 → 驗證 → 由輔助程序先備份、安裝、檢查新版本號，失敗時自動還原 |
| `splash.rs` + `src/pikara-splash/` | 可重用啟動畫面，見該資料夾 README |

### 更新頻道

- **Stable**：非 prerelease 的正式版
- **Beta**：另含 `beta` / `rc` 預先發布版
- **Alpha**：所有預先發布版

### 發布簽章

產品清單可設定 `minisignPublicKey`（minisign 或 Tauri updater 格式）。設定後，該產品的每個安裝檔都**必須**附 `<檔名>.sig` 且驗證通過，否則拒絕安裝。未設定時，介面如實顯示「尚未設定發布簽章公鑰」。目前 Pikara Science Studio 的發布版本沒有附簽章，只做 SHA-256 驗證（GitHub digest 與 SHA256SUMS 兩者都會比對）。

### 新增產品

在 `products.json` 加一筆即可。`repo` 為 `null`，或 repo 還沒有任何 release 時，顯示「開發中」，不會產生任何下載連結。已有 release 但沒有目前平台的檔案時，顯示「此平台尚無版本」。

## 開發階段

| 階段 | 狀態 |
|---|---|
| P0 跨平台專案、品牌 UI、Splash、GitHub 版本查詢 | ✅ 完成（已在 Windows x64 實測） |
| P1 真實下載、安裝、啟動、更新、解除安裝 | ✅ 完成（已在 Windows x64 實測，見下） |
| P2 共用 Runtime、下載管理、版本回復 | 🟡 下載管理與版本回復已完成；硬體後端偵測完成；Runtime 安裝尚未實作（介面標示「開發中」） |
| P3 Windows EXE、macOS APP/DMG、GitHub Actions | 🟡 `.github/workflows/build.yml` 已撰寫，尚未在 GitHub 上執行；Windows 安裝檔已在本機建置 |

### 實測紀錄

見 [docs/TESTING.md](docs/TESTING.md)。

### macOS

本機的 WSL 沒有可用的 macOS SDK 與交叉編譯工具鏈，無法可靠打包 macOS，因此 macOS（ARM64 與 Intel）一律由 GitHub Actions 的 `macos-14` runner 原生建置。macOS 專屬程式碼（DMG 掛載、`.app` 啟動、Metal 偵測、Rosetta 偵測）尚未在實機上測試，可用 Mac mini M2 驗證。
