//! Reusable splash-screen controller for Pikara apps.
//!
//! Contract (see `src/pikara-splash/README.md`):
//! * window `splash` — small, frameless, transparent; shown by its frontend after first paint.
//! * window `main`   — created hidden; its frontend calls `main_ready` once fully rendered.
//! * the backend reports real init steps via [`SplashController::step`] and calls
//!   [`SplashController::backend_done`] when finished.
//! * when both sides are ready the splash receives `splash://complete`, plays its exit
//!   animation, calls `splash_reveal_main` (main appears underneath) and then `splash_close`.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::watch;

pub const SPLASH: &str = "splash";
pub const MAIN: &str = "main";

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SplashSnapshot {
    pub step: u32,
    pub total: u32,
    pub message: String,
    pub backend_done: bool,
    pub frontend_ready: bool,
    pub complete: bool,
    pub warning: Option<String>,
    /// Milliseconds since process start, for diagnostics.
    pub backend_done_ms: Option<u64>,
    pub frontend_ready_ms: Option<u64>,
    pub complete_ms: Option<u64>,
}

pub struct SplashController {
    snap: Mutex<SplashSnapshot>,
    ready_tx: watch::Sender<bool>,
    revealed: AtomicBool,
    started: std::time::Instant,
}

impl SplashController {
    pub fn new(total: u32) -> Self {
        let (ready_tx, _) = watch::channel(false);
        Self {
            snap: Mutex::new(SplashSnapshot { total, message: "正在啟動…".into(), ..Default::default() }),
            ready_tx,
            revealed: AtomicBool::new(false),
            started: std::time::Instant::now(),
        }
    }

    pub fn snapshot(&self) -> SplashSnapshot {
        self.snap.lock().unwrap().clone()
    }

    fn publish<R: Runtime>(&self, app: &AppHandle<R>) {
        let _ = app.emit("splash://status", self.snapshot());
    }

    pub fn step<R: Runtime>(&self, app: &AppHandle<R>, step: u32, message: impl Into<String>) {
        {
            let mut s = self.snap.lock().unwrap();
            s.step = step;
            s.message = message.into();
        }
        self.publish(app);
    }

    pub fn warn(&self, warning: impl Into<String>) {
        self.snap.lock().unwrap().warning = Some(warning.into());
    }

    pub fn backend_done<R: Runtime>(&self, app: &AppHandle<R>) {
        {
            let mut s = self.snap.lock().unwrap();
            s.backend_done = true;
            s.backend_done_ms = Some(self.started.elapsed().as_millis() as u64);
            s.step = s.total;
            s.message = "正在載入介面…".into();
        }
        // send_replace stores the value even when nobody is subscribed yet (send() would drop it).
        self.ready_tx.send_replace(true);
        self.publish(app);
        self.maybe_complete(app);
    }

    pub fn frontend_ready<R: Runtime>(&self, app: &AppHandle<R>) {
        {
            let mut s = self.snap.lock().unwrap();
            if !s.frontend_ready {
                s.frontend_ready = true;
                s.frontend_ready_ms = Some(self.started.elapsed().as_millis() as u64);
            }
        }
        self.maybe_complete(app);
    }

    pub fn ready_receiver(&self) -> watch::Receiver<bool> {
        self.ready_tx.subscribe()
    }

    fn maybe_complete<R: Runtime>(&self, app: &AppHandle<R>) {
        let fire = {
            let mut s = self.snap.lock().unwrap();
            if s.backend_done && s.frontend_ready && !s.complete {
                s.complete = true;
                s.complete_ms = Some(self.started.elapsed().as_millis() as u64);
                s.message = "準備就緒".into();
                true
            } else {
                false
            }
        };
        if fire {
            self.publish(app);
            let _ = app.emit("splash://complete", ());
            // Safety net: if the splash page never answers, still show the app.
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(4)).await;
                reveal_main(&app);
                close_splash(&app);
            });
        }
    }

    pub fn mark_revealed(&self) -> bool {
        !self.revealed.swap(true, Ordering::SeqCst)
    }
}

pub fn show_splash<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(SPLASH) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn reveal_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(ctrl) = app.try_state::<SplashController>() else { return };
    if !ctrl.mark_revealed() {
        return;
    }
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit("splash://reveal", ());
    // Keep the fading splash above the freshly focused main window.
    if let Some(s) = app.get_webview_window(SPLASH) {
        let _ = s.set_always_on_top(true);
    }
}

pub fn close_splash<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(SPLASH) {
        let _ = w.destroy();
    }
}
