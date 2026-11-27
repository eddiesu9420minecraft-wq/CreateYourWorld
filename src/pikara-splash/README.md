# pikara-splash — 可重用的啟動畫面與轉場

給所有 Pikara 軟體共用的 PowerPoint 式啟動流程。前端：本資料夾；後端：`src-tauri/src/splash.rs`。

## 流程

1. `splash` 視窗（小型、無標題列、透明、圓角）建立時為隱藏；前端首次繪製後呼叫 `splash_shown` 才顯示 → 不會白屏或閃爍。
2. `main` 視窗建立時即隱藏，背景色與主題相同，並預先繪製 `<RevealOverlay/>`。
3. 後端以 `SplashController::step()` 回報**真實**初始化步驟，完成後呼叫 `backend_done()`。
4. 主視窗載入完真實資料並 commit 後呼叫 `main_ready`（使用 `useLayoutEffect`，因為隱藏視窗的計時器與 rAF 會被節流）。
5. 兩者都就緒 → 發出 `splash://complete`。Splash 播放退場動畫（四角楔形飛向四角並放大、淡出），同時呼叫 `splash_reveal_main` 顯示主視窗；主視窗的 overlay 接續把 Logo 拉伸到視窗四角後淡出。
6. Splash 呼叫 `splash_close` 銷毀自己。若前端未回應，後端有逾時保險（主視窗 10 秒、splash 4 秒），不會卡住。

沒有任何刻意延遲：就緒的瞬間就開始轉場。

## 在其他 Pikara 專案中使用

1. 複製 `src/pikara-splash/` 與 `src-tauri/src/splash.rs`。
2. `tauri.conf.json` 建立兩個視窗：`splash`（`decorations:false, transparent:true, visible:false, shadow:false`）與 `main`（`visible:false, backgroundColor` 設為主題底色），並開啟 `macOSPrivateApi`（macOS 透明視窗需要）。
3. Rust：`.manage(SplashController::new(步驟數))`，註冊 `splash_status / splash_shown / splash_reveal_main / splash_close / main_ready / wait_ready` 指令（參考 `lib.rs`），在 setup 中 spawn 你的初始化工作。
4. 前端：依 `getCurrentWindow().label` 渲染 `<SplashScreen productName tagline byline/>` 或主程式；主程式掛上 `<RevealOverlay/>`，資料就緒後呼叫 `splashBridge.mainReady()`。
5. Capability 需要 `core:window:allow-start-dragging`（splash 可拖曳）。
