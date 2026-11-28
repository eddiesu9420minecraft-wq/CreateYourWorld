//! Secure self-update of Create Your World. itself.
//!
//! 1. Fetch `update.json` + `update.json.sig` from the repo (raw.githubusercontent.com) through
//!    Pikara Secure Network (DoH, HTTPS-only, allow-listed hosts).
//! 2. Verify the manifest signature with the compiled-in Pikara key, plus product, SemVer,
//!    anti-downgrade and anti-replay rules (`pikara_secure::manifest`).
//! 3. Download through the regular download queue (resumable), then verify SHA-256 *and* the
//!    minisign signature in one streaming pass. Any failure deletes the file.
//! 4. Apply with a helper process after CYW exits: back up → install → check the new binary
//!    reports the expected version → otherwise restore the backup. User data is never touched.

use crate::hub::SharedCore;
use crate::install::InstallKind;
use crate::settings::UpdateMode;
use crate::util::{hidden_command, load_json, now_secs, save_json};
use pikara_secure::manifest::{self, Policy, ReplayState, Verdict};
use pikara_secure::{keys, net, SecureError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use crate::host::{App, HostExt};

pub const PRODUCT_ID: &str = "create-your-world";
pub const VERSION: &str = crate::VERSION;
const MANIFEST_URL: &str = "https://raw.githubusercontent.com/eddiesu9420minecraft-wq/CreateYourWorld/main/update.json";
const RELEASE_PREFIX: &str = "https://github.com/eddiesu9420minecraft-wq/CreateYourWorld/releases/download/";

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SelfUpdateStatus {
    pub current: String,
    /// idle | checking | up-to-date | available | downloading | ready | error | unsupported
    pub state: String,
    pub latest: Option<String>,
    pub notes: Option<String>,
    pub error: Option<String>,
    /// The failure was a security check (bad signature, downgrade, replay, URL), not a network issue.
    pub security_alert: bool,
    pub checked_at: Option<u64>,
    pub job_id: Option<u64>,
    /// Why this build cannot update itself (dev build, unsupported platform).
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Staged {
    pub version: String,
    pub file: PathBuf,
    pub kind: InstallKind,
}

pub struct SelfUpdater {
    status: Mutex<SelfUpdateStatus>,
    offer: Mutex<Option<(String, String, manifest::PlatformEntry)>>, // version, notes, entry
    staged: Mutex<Option<Staged>>,
}

impl SelfUpdater {
    pub fn new() -> Self {
        let mut s = SelfUpdateStatus { current: VERSION.into(), state: "idle".into(), ..Default::default() };
        if let Err(reason) = install_target() {
            s.state = "unsupported".into();
            s.unsupported_reason = Some(reason);
        }
        Self { status: Mutex::new(s), offer: Mutex::new(None), staged: Mutex::new(None) }
    }
    pub fn status(&self) -> SelfUpdateStatus {
        self.status.lock().unwrap().clone()
    }
    pub fn staged(&self) -> Option<Staged> {
        self.staged.lock().unwrap().clone()
    }
}

fn set(core: &SharedCore, app: &App, f: impl FnOnce(&mut SelfUpdateStatus)) {
    let s = {
        let mut st = core.selfupdate.status.lock().unwrap();
        f(&mut st);
        st.clone()
    };
    let _ = app.emit("selfupdate://status", s);
}

/// Where the running CYW is installed, if it was installed by our installer.
pub fn install_target() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if manifest::platform_key().is_none() {
        return Err("此平台尚不支援自動更新".into());
    }
    #[cfg(windows)]
    {
        let dir = exe.parent().ok_or("無法取得安裝位置")?.to_path_buf();
        if dir.join("uninstall.exe").exists() {
            return Ok(dir);
        }
        return Err("目前執行的不是安裝版（開發版本不會自動更新）".into());
    }
    #[cfg(target_os = "macos")]
    {
        // …/Create Your World.app/Contents/MacOS/create-your-world
        if let Some(app) = exe.ancestors().find(|p| p.extension().is_some_and(|x| x == "app")) {
            return Ok(app.to_path_buf());
        }
        return Err("目前執行的不是 .app 套件，無法自動更新".into());
    }
    #[allow(unreachable_code)]
    Err("此平台尚不支援自動更新".into())
}

fn state_file(core: &SharedCore) -> PathBuf {
    core.paths.data.join("update-state.json")
}

fn is_security(e: &SecureError) -> bool {
    matches!(e, SecureError::BadSignature(_) | SecureError::Sha256Mismatch { .. } | SecureError::Downgrade { .. } | SecureError::Replay(_) | SecureError::UrlRejected(_) | SecureError::Manifest(_))
}

/// Check for a CYW update. Never blocks startup; network failure is just a status.
pub async fn check(core: &SharedCore, app: &App, mode: UpdateMode) {
    if core.selfupdate.status().state == "unsupported" {
        return;
    }
    if matches!(core.selfupdate.status().state.as_str(), "downloading" | "ready") {
        return;
    }
    set(core, app, |s| {
        s.state = "checking".into();
        s.error = None;
        s.security_alert = false;
    });

    let result: Result<Verdict, SecureError> = async {
        let json = net::fetch_small(&core.api_http, MANIFEST_URL, net::GITHUB_HOSTS, 256 * 1024).await?;
        let sig = net::fetch_small(&core.api_http, &format!("{MANIFEST_URL}.sig"), net::GITHUB_HOSTS, 16 * 1024).await?;
        let sig = String::from_utf8(sig).map_err(|_| SecureError::BadSignature("簽章不是文字".into()))?;
        let platform_key = manifest::platform_key().unwrap_or_default();
        let policy = Policy { product: PRODUCT_ID, pubkey: keys::PIKARA_RELEASE_PUBKEY, current_version: VERSION, release_prefix: RELEASE_PREFIX, platform_key };
        let replay: ReplayState = load_json(&state_file(core));
        let (verdict, new_state) = manifest::verify(&json, &sig, &policy, &replay)?;
        save_json(&state_file(core), &new_state).map_err(SecureError::from)?;
        Ok(verdict)
    }
    .await;

    match result {
        Ok(Verdict::UpToDate { latest }) => set(core, app, |s| {
            s.state = "up-to-date".into();
            s.latest = Some(latest);
            s.checked_at = Some(now_secs());
        }),
        Ok(Verdict::Update { manifest, entry }) => {
            *core.selfupdate.offer.lock().unwrap() = Some((manifest.version.clone(), manifest.notes.clone(), entry));
            set(core, app, |s| {
                s.state = "available".into();
                s.latest = Some(manifest.version.clone());
                s.notes = Some(manifest.notes.clone());
                s.checked_at = Some(now_secs());
            });
            if mode == UpdateMode::Auto {
                let _ = download(core, app).await;
            }
        }
        Err(e) => {
            let sec = is_security(&e);
            set(core, app, |s| {
                s.state = "error".into();
                s.error = Some(e.to_string());
                s.security_alert = sec;
                s.checked_at = Some(now_secs());
            });
        }
    }
}

/// Queue the verified offer in the normal download manager.
pub async fn download(core: &SharedCore, app: &App) -> anyhow::Result<u64> {
    let (version, _notes, entry) = core.selfupdate.offer.lock().unwrap().clone().ok_or_else(|| anyhow::anyhow!("沒有可用的更新"))?;
    let kind = if cfg!(windows) { InstallKind::Nsis } else { InstallKind::AppTar };
    let id = crate::downloads::enqueue_self_update(core, app, &version, &entry, kind)?;
    set(core, app, |s| {
        s.state = "downloading".into();
        s.job_id = Some(id);
    });
    Ok(id)
}

/// Called by the download pipeline once the file passed SHA-256 + signature verification.
pub fn staged(core: &SharedCore, app: &App, version: &str, file: PathBuf, kind: InstallKind) -> anyhow::Result<()> {
    let dir = core.paths.data.join("self-update").join(crate::util::sanitize_component(version));
    std::fs::create_dir_all(&dir)?;
    // Drop the download's ".part" suffix and product/version prefix: stage under the real asset name.
    let name = file.file_name().unwrap_or_default().to_string_lossy().trim_end_matches(".part").to_string();
    let prefix = format!("{}-{}-", PRODUCT_ID, crate::util::sanitize_component(version));
    let dst = dir.join(name.strip_prefix(&prefix).unwrap_or(&name));
    if std::fs::rename(&file, &dst).is_err() {
        std::fs::copy(&file, &dst)?;
        let _ = std::fs::remove_file(&file);
    }
    *core.selfupdate.staged.lock().unwrap() = Some(Staged { version: version.into(), file: dst, kind });
    set(core, app, |s| s.state = "ready".into());
    Ok(())
}

pub fn failed(core: &SharedCore, app: &App, error: String, security: bool) {
    set(core, app, |s| {
        s.state = "error".into();
        s.error = Some(error);
        s.security_alert = security;
    });
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ApplyPlan {
    pub parent_pid: u32,
    pub kind: InstallKind,
    pub package: PathBuf,
    pub target: PathBuf,
    pub exe_name: String,
    pub expected_version: String,
    pub relaunch: bool,
    pub log: PathBuf,
}

/// Spawn the helper; the caller must exit CYW right after so files can be replaced.
pub fn spawn_apply(core: &SharedCore, relaunch: bool) -> anyhow::Result<()> {
    let staged = core.selfupdate.staged().ok_or_else(|| anyhow::anyhow!("沒有已驗證的更新"))?;
    let target = install_target().map_err(|e| anyhow::anyhow!(e))?;
    let exe = std::env::current_exe()?;
    let work = core.paths.data.join("self-update");
    let helper = work.join(format!("cyw-update-helper-{}{}", now_secs(), std::env::consts::EXE_SUFFIX));
    std::fs::copy(&exe, &helper)?;
    let plan = ApplyPlan {
        parent_pid: std::process::id(),
        kind: staged.kind,
        package: staged.file,
        target,
        exe_name: exe.file_name().unwrap_or_default().to_string_lossy().into(),
        expected_version: staged.version,
        relaunch,
        log: work.join("helper.log"),
    };
    let plan_path = work.join("apply-plan.json");
    save_json(&plan_path, &plan)?;
    hidden_command(&helper).arg("--pikara-apply-update").arg(&plan_path).spawn()?;
    Ok(())
}

// ------------------------------------------------------------------------------------------
// Helper mode (runs from a temporary copy of the CYW binary, before Tauri starts)
// ------------------------------------------------------------------------------------------

fn log(plan: &ApplyPlan, msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&plan.log) {
        let _ = writeln!(f, "[{}] {msg}", now_secs());
    }
}

#[cfg(windows)]
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let to = dst.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &to)?;
        } else {
            std::fs::copy(e.path(), to)?;
        }
    }
    Ok(())
}

fn reported_version(exe: &Path) -> Option<String> {
    let out = hidden_command(exe).arg("--pikara-version").output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn run_helper(plan_path: &Path) -> i32 {
    let plan: ApplyPlan = match std::fs::read(plan_path).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
        Some(p) => p,
        None => return 2,
    };
    log(&plan, &format!("helper start: {} -> {}", plan.package.display(), plan.target.display()));
    if !crate::procs::wait_pid_exit(plan.parent_pid, std::time::Duration::from_secs(90)) {
        log(&plan, "CYW did not exit; aborting (nothing changed)");
        return 3;
    }
    let ok = apply(&plan);
    log(&plan, if ok { "update applied" } else { "update failed; previous version restored" });
    if plan.relaunch || !ok {
        relaunch(&plan);
    }
    if ok { 0 } else { 1 }
}

fn backup_path(target: &Path) -> PathBuf {
    let name = target.file_name().unwrap_or_default().to_string_lossy().to_string();
    target.with_file_name(format!("{name}.cyw-backup"))
}

#[cfg(windows)]
fn apply(plan: &ApplyPlan) -> bool {
    use std::os::windows::process::CommandExt;
    let backup = backup_path(&plan.target);
    let _ = std::fs::remove_dir_all(&backup);
    if let Err(e) = copy_dir(&plan.target, &backup) {
        log(plan, &format!("backup failed: {e}; not updating"));
        return false;
    }
    let status = std::process::Command::new(&plan.package)
        .arg("/S")
        .raw_arg(format!("/D={}", plan.target.display()))
        .status();
    let new_exe = plan.target.join(&plan.exe_name);
    let installed_ok = matches!(&status, Ok(s) if s.success());
    let version = reported_version(&new_exe);
    log(plan, &format!("installer status {status:?}, new binary reports {version:?}"));
    if installed_ok && version.as_deref() == Some(plan.expected_version.as_str()) {
        let _ = std::fs::remove_dir_all(&backup);
        let _ = std::fs::remove_file(&plan.package);
        return true;
    }
    // Roll back: put the previous files back exactly as they were.
    let _ = std::fs::remove_dir_all(&plan.target);
    if let Err(e) = std::fs::rename(&backup, &plan.target).or_else(|_| copy_dir(&backup, &plan.target)) {
        log(plan, &format!("ROLLBACK FAILED: {e}; backup kept at {}", backup.display()));
    }
    false
}

#[cfg(target_os = "macos")]
fn apply(plan: &ApplyPlan) -> bool {
    let parent = match plan.target.parent() {
        Some(p) => p.to_path_buf(),
        None => return false,
    };
    let staging = parent.join(format!(".cyw-staging-{}", now_secs()));
    let _ = std::fs::remove_dir_all(&staging);
    if let Err(e) = std::fs::create_dir_all(&staging).map_err(anyhow::Error::from).and_then(|_| crate::archive::extract_tar_gz(&plan.package, &staging)) {
        log(plan, &format!("extract failed: {e}"));
        let _ = std::fs::remove_dir_all(&staging);
        return false;
    }
    let new_app = std::fs::read_dir(&staging).ok().and_then(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "app")));
    let Some(new_app) = new_app else {
        log(plan, "no .app in archive");
        let _ = std::fs::remove_dir_all(&staging);
        return false;
    };
    let backup = backup_path(&plan.target);
    let _ = std::fs::remove_dir_all(&backup);
    if let Err(e) = std::fs::rename(&plan.target, &backup) {
        log(plan, &format!("cannot move current app aside: {e}"));
        let _ = std::fs::remove_dir_all(&staging);
        return false;
    }
    if std::fs::rename(&new_app, &plan.target).is_ok() {
        let exe = plan.target.join("Contents/MacOS").join(&plan.exe_name);
        let v = reported_version(&exe);
        log(plan, &format!("new binary reports {v:?}"));
        if v.as_deref() == Some(plan.expected_version.as_str()) {
            let _ = std::fs::remove_dir_all(&backup);
            let _ = std::fs::remove_dir_all(&staging);
            let _ = std::fs::remove_file(&plan.package);
            return true;
        }
        let _ = std::fs::remove_dir_all(&plan.target);
    }
    let _ = std::fs::rename(&backup, &plan.target);
    let _ = std::fs::remove_dir_all(&staging);
    false
}

#[cfg(not(any(windows, target_os = "macos")))]
fn apply(plan: &ApplyPlan) -> bool {
    log(plan, "self-update not supported on this platform");
    false
}

fn relaunch(plan: &ApplyPlan) {
    #[cfg(target_os = "macos")]
    {
        let r = std::process::Command::new("open").arg(&plan.target).status();
        log(plan, &format!("relaunch via open: {r:?}"));
    }
    #[cfg(not(target_os = "macos"))]
    {
        // The previous instance's WebView2 processes can linger for a moment after it exits;
        // verify the relaunched app stays up and retry a few times if it does not.
        let exe = plan.target.join(&plan.exe_name);
        for attempt in 1..=5 {
            match std::process::Command::new(&exe).current_dir(&plan.target).spawn() {
                Ok(mut child) => {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    match child.try_wait() {
                        Ok(None) => {
                            log(plan, &format!("relaunched (attempt {attempt}), pid {} is running", child.id()));
                            return;
                        }
                        Ok(Some(st)) => log(plan, &format!("relaunch attempt {attempt}: process exited early ({st})")),
                        Err(e) => log(plan, &format!("relaunch attempt {attempt}: {e}")),
                    }
                }
                Err(e) => log(plan, &format!("relaunch attempt {attempt}: spawn failed: {e}")),
            }
            std::thread::sleep(std::time::Duration::from_secs(3));
        }
        log(plan, "relaunch failed after 5 attempts; the updated app can be started normally");
    }
}
