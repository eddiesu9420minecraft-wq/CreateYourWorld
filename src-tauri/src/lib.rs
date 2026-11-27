mod archive;
mod catalog;
mod hub;
mod downloads;
mod github;
mod install;
mod paths;
mod platform;
mod procs;
mod runtime;
mod selfupdate;
mod settings;
pub mod splash;
mod util;
mod verify;

use crate::hub::{Core, ProductView, SharedCore};
use crate::downloads::JobInfo;
use crate::github::{Channel, RateInfo};
use crate::settings::{Settings, UpdateMode};
use crate::splash::{SplashController, SplashSnapshot};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_opener::OpenerExt;

type Res<T> = Result<T, String>;

/// Non-GUI entry points. Returns an exit code when the process should not start the GUI.
pub fn cli_entry() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--pikara-version") => {
            println!("{}", selfupdate::VERSION);
            Some(0)
        }
        Some("--pikara-apply-update") => Some(args.get(2).map(|p| selfupdate::run_helper(std::path::Path::new(p))).unwrap_or(2)),
        _ => None,
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

const INIT_STEPS: u32 = 5;

/// Real startup work, reported step by step to the splash screen. No artificial delays.
async fn initialize(app: AppHandle, core: SharedCore) {
    let splash = app.state::<SplashController>();

    splash.step(&app, 1, "正在準備資料目錄…");
    if let Err(e) = core.paths.ensure() {
        splash.warn(format!("無法建立資料目錄：{e}"));
    }

    splash.step(&app, 2, "正在讀取設定…");
    *core.settings.write().unwrap() = util::load_json::<Settings>(&core.paths.settings_file()).clamp();

    splash.step(&app, 3, "正在檢查已安裝的應用程式…");
    *core.installed.lock().unwrap() = util::load_json(&core.paths.installed_file());
    let c = core.clone();
    let _ = tokio::task::spawn_blocking(move || hub::verify_installed(&c)).await;

    splash.step(&app, 4, "正在恢復下載佇列…");
    core.jobs.restore();

    splash.step(&app, 5, "正在向 GitHub 查詢最新版本…");
    // Warms the release cache so the main window opens with real data.
    // Bounded so an unreachable network can't hold the splash forever; failures fall back to cache.
    let _ = tokio::time::timeout(Duration::from_secs(12), hub::product_views(&core, false)).await;

    splash.backend_done(&app);

    // Update checks run in the background after startup; they never block the splash.
    tauri::async_runtime::spawn(scheduler(app.clone(), core.clone()));

    // Safety net: never leave the user staring at the splash if the main page fails to report.
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        h.state::<SplashController>().frontend_ready(&h);
    });
}

#[tauri::command]
fn splash_status(splash: State<'_, SplashController>) -> SplashSnapshot {
    splash.snapshot()
}

#[tauri::command]
fn splash_shown(app: AppHandle) {
    splash::show_splash(&app);
}

#[tauri::command]
fn splash_reveal_main(app: AppHandle) {
    splash::reveal_main(&app);
}

#[tauri::command]
fn splash_close(app: AppHandle) {
    splash::close_splash(&app);
}

#[tauri::command]
fn main_ready(app: AppHandle, splash: State<'_, SplashController>) {
    splash.frontend_ready(&app);
}

/// Resolves once backend initialization has finished.
#[tauri::command]
async fn wait_ready(splash: State<'_, SplashController>) -> Res<()> {
    let mut rx = splash.ready_receiver();
    rx.wait_for(|v| *v).await.map_err(err)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: &'static str,
    platform: platform::Platform,
    paths: paths::Paths,
}

#[tauri::command]
fn app_info(core: State<'_, SharedCore>) -> AppInfo {
    AppInfo { version: env!("CARGO_PKG_VERSION"), platform: core.platform.clone(), paths: core.paths.clone() }
}

#[tauri::command]
async fn get_products(core: State<'_, SharedCore>, force: bool) -> Res<Vec<ProductView>> {
    Ok(hub::product_views(&core, force).await)
}

#[tauri::command]
async fn install_app(app: AppHandle, core: State<'_, SharedCore>, product_id: String, tag: Option<String>) -> Res<InstallOutcome> {
    // Never touch a running app: remember the request and update after the user quits it.
    if core.installed_app(&product_id).is_some() && hub::is_running(&core, &product_id) {
        core.pending_updates.lock().unwrap().insert(product_id.clone());
        core.notify_apps_changed(&app);
        return Ok(InstallOutcome { job_id: None, switched_to: None, deferred: true });
    }
    // A version kept on disk (e.g. after a rollback) is switched to instead of downloaded again.
    if let Some(t) = &tag {
        hub::ensure_not_busy(&core, &product_id).map_err(err)?;
        if hub::switch_to(&core, &product_id, t).map_err(err)? {
            core.notify_apps_changed(&app);
            return Ok(InstallOutcome { job_id: None, switched_to: Some(t.clone()), deferred: false });
        }
    }
    let id = downloads::enqueue(&core, &app, &product_id, tag).await.map_err(err)?;
    Ok(InstallOutcome { job_id: Some(id), switched_to: None, deferred: false })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallOutcome {
    job_id: Option<u64>,
    switched_to: Option<String>,
    deferred: bool,
}

#[tauri::command]
fn launch_app(core: State<'_, SharedCore>, product_id: String) -> Res<()> {
    hub::launch_current(&core, &product_id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn uninstall_app(app: AppHandle, core: State<'_, SharedCore>, product_id: String) -> Res<()> {
    hub::ensure_not_busy(&core, &product_id).map_err(err)?;
    let c = core.inner().clone();
    let pid = product_id.clone();
    tokio::task::spawn_blocking(move || hub::uninstall(&c, &pid)).await.map_err(err)?.map_err(|e| format!("{e:#}"))?;
    core.notify_apps_changed(&app);
    Ok(())
}

#[tauri::command]
fn rollback_app(app: AppHandle, core: State<'_, SharedCore>, product_id: String) -> Res<String> {
    hub::ensure_not_busy(&core, &product_id).map_err(err)?;
    let tag = hub::rollback(&core, &product_id).map_err(err)?;
    core.notify_apps_changed(&app);
    Ok(tag)
}

#[tauri::command]
fn open_app_folder(app: AppHandle, core: State<'_, SharedCore>, product_id: String) -> Res<()> {
    let inst = core.installed_app(&product_id).ok_or("尚未安裝")?;
    let v = inst.current_version().ok_or("找不到目前版本")?;
    app.opener().reveal_item_in_dir(&v.launch).map_err(err)
}

#[tauri::command]
fn open_data_dir(app: AppHandle, core: State<'_, SharedCore>) -> Res<()> {
    app.opener().open_path(core.paths.data.to_string_lossy(), None::<&str>).map_err(err)
}

#[tauri::command]
fn open_release_page(app: AppHandle, url: String) -> Res<()> {
    // Only GitHub pages; never arbitrary URLs from release text.
    if !url.starts_with("https://github.com/") {
        return Err("只允許開啟 GitHub 頁面".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

#[tauri::command]
fn list_jobs(core: State<'_, SharedCore>) -> Vec<JobInfo> {
    core.jobs.list()
}

#[tauri::command]
fn pause_job(app: AppHandle, core: State<'_, SharedCore>, id: u64) {
    downloads::pause(&core, &app, id)
}

#[tauri::command]
fn resume_job(app: AppHandle, core: State<'_, SharedCore>, id: u64) {
    downloads::resume(&core, &app, id)
}

#[tauri::command]
fn cancel_job(app: AppHandle, core: State<'_, SharedCore>, id: u64) {
    downloads::cancel(&core, &app, id)
}

#[tauri::command]
fn clear_finished_jobs(core: State<'_, SharedCore>) {
    core.jobs.clear_finished()
}

#[tauri::command]
fn get_settings(core: State<'_, SharedCore>) -> Settings {
    core.settings.read().unwrap().clone()
}

#[tauri::command]
fn save_settings(app: AppHandle, core: State<'_, SharedCore>, settings: Settings) -> Res<Settings> {
    let s = settings.clamp();
    util::save_json(&core.paths.settings_file(), &s).map_err(err)?;
    *core.settings.write().unwrap() = s.clone();
    downloads::pump(&core, &app); // concurrency may have increased
    Ok(s)
}

#[tauri::command]
fn set_channel(core: State<'_, SharedCore>, product_id: String, channel: Channel) -> Res<()> {
    let mut s = core.settings.write().unwrap();
    s.channels.insert(product_id, channel);
    util::save_json(&core.paths.settings_file(), &*s).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiStatus {
    rate: RateInfo,
    token_source: Option<&'static str>,
}

#[tauri::command]
fn github_status(core: State<'_, SharedCore>) -> ApiStatus {
    let rate = core.github.rate_info();
    let token_source = rate.authenticated.then_some("環境變數 GITHUB_TOKEN / GH_TOKEN");
    ApiStatus { rate, token_source }
}

#[tauri::command]
fn clear_api_cache(core: State<'_, SharedCore>) -> Res<()> {
    core.github.clear_cache().map_err(err)
}

#[tauri::command]
async fn detect_hardware(core: State<'_, SharedCore>) -> Res<runtime::HardwareReport> {
    let r = core
        .hardware
        .get_or_try_init(|| async { tokio::task::spawn_blocking(runtime::detect).await })
        .await
        .map_err(err)?;
    Ok(r.clone())
}

// ---------------------------------------------------------------- updates ----

/// Startup check, then a full check every 60 minutes; deferred app updates are retried every
/// minute once the app has been closed.
async fn scheduler(app: AppHandle, core: SharedCore) {
    tokio::time::sleep(Duration::from_secs(3)).await;
    let mut last_full: Option<std::time::Instant> = None;
    loop {
        if last_full.is_none_or(|t| t.elapsed() >= Duration::from_secs(60 * 60)) {
            update_cycle(&app, &core).await;
            last_full = Some(std::time::Instant::now());
        }
        process_pending(&app, &core).await;
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

async fn update_cycle(app: &AppHandle, core: &SharedCore) {
    let (self_mode, apps_mode) = {
        let s = core.settings.read().unwrap();
        (s.self_update_mode, s.apps_update_mode)
    };
    if self_mode != UpdateMode::Manual {
        selfupdate::check(core, app, self_mode).await;
    }
    if apps_mode != UpdateMode::Manual {
        let views = hub::product_views(core, true).await;
        let available: Vec<_> = views.iter().filter(|v| v.update.is_some()).collect();
        if apps_mode == UpdateMode::Auto {
            for v in &available {
                request_app_update(app, core, &v.id).await;
            }
        }
        let _ = app.emit("updates://checked", available.len());
        core.notify_apps_changed(app);
    }
}

async fn request_app_update(app: &AppHandle, core: &SharedCore, product_id: &str) {
    if hub::is_running(core, product_id) {
        core.pending_updates.lock().unwrap().insert(product_id.to_string());
        return;
    }
    if !core.jobs.has_active(product_id) {
        let _ = downloads::enqueue(core, app, product_id, None).await;
    }
}

async fn process_pending(app: &AppHandle, core: &SharedCore) {
    let pending: Vec<String> = core.pending_updates.lock().unwrap().iter().cloned().collect();
    for id in pending {
        if !hub::is_running(core, &id) {
            core.pending_updates.lock().unwrap().remove(&id);
            if !core.jobs.has_active(&id) {
                let _ = downloads::enqueue(core, app, &id, None).await;
            }
            core.notify_apps_changed(app);
        }
    }
}

#[tauri::command]
fn self_update_status(core: State<'_, SharedCore>) -> selfupdate::SelfUpdateStatus {
    core.selfupdate.status()
}

#[tauri::command]
async fn check_self_update(app: AppHandle, core: State<'_, SharedCore>) -> Res<selfupdate::SelfUpdateStatus> {
    // A manual check never auto-installs; it only reports.
    selfupdate::check(&core, &app, UpdateMode::Notify).await;
    Ok(core.selfupdate.status())
}

#[tauri::command]
async fn download_self_update(app: AppHandle, core: State<'_, SharedCore>) -> Res<u64> {
    selfupdate::download(&core, &app).await.map_err(err)
}

/// Apply the verified update now and restart CYW.
#[tauri::command]
fn apply_self_update(app: AppHandle, core: State<'_, SharedCore>) -> Res<()> {
    selfupdate::spawn_apply(&core, true).map_err(err)?;
    app.exit(0);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkStatus {
    ok: bool,
    provider: Option<String>,
    addresses: Vec<String>,
    error: Option<String>,
}

/// Resolve api.github.com through Pikara Secure Network (DoH) and report which provider answered.
#[tauri::command]
async fn network_status(core: State<'_, SharedCore>) -> Res<NetworkStatus> {
    Ok(match core.resolver.lookup("api.github.com").await {
        Ok(l) => NetworkStatus { ok: true, provider: Some(l.provider.to_string()), addresses: l.addrs.iter().map(|a| a.to_string()).collect(), error: None },
        Err(e) => NetworkStatus { ok: false, provider: None, addresses: vec![], error: Some(e.to_string()) },
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SplashController::new(INIT_STEPS))
        .setup(|app| {
            let handle = app.handle().clone();
            let paths = paths::Paths::resolve(&handle)?;
            let core: SharedCore = Arc::new(Core::new(paths)?);
            app.manage(core.clone());

            // Fallback: show the splash even if its page is slow to report first paint.
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                if !h.state::<SplashController>().snapshot().complete {
                    splash::show_splash(&h);
                }
            });

            tauri::async_runtime::spawn(initialize(handle, core));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            splash_status,
            splash_shown,
            splash_reveal_main,
            splash_close,
            main_ready,
            wait_ready,
            app_info,
            get_products,
            install_app,
            launch_app,
            uninstall_app,
            rollback_app,
            open_app_folder,
            open_data_dir,
            open_release_page,
            list_jobs,
            pause_job,
            resume_job,
            cancel_job,
            clear_finished_jobs,
            get_settings,
            save_settings,
            set_channel,
            github_status,
            clear_api_cache,
            detect_hardware,
            self_update_status,
            check_self_update,
            download_self_update,
            apply_self_update,
            network_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Create Your World")
        .run(|app, event| {
            // Auto mode: a verified, staged CYW update is applied when the user quits.
            if let RunEvent::Exit = event {
                if let Some(core) = app.try_state::<SharedCore>() {
                    let auto = core.settings.read().unwrap().self_update_mode == UpdateMode::Auto;
                    if auto && core.selfupdate.staged().is_some() {
                        let _ = selfupdate::spawn_apply(&core, false);
                    }
                }
            }
        });
}
