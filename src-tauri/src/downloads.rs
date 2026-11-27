//! Download queue: resumable HTTP downloads → verification → installation.

use crate::hub::{prune_versions, resolve_release, SharedCore};
use crate::github::GhRelease;
use crate::install::{self, InstalledApp, InstalledVersion};
use crate::platform::SelectedAsset;
use crate::util::{load_json, now_secs, sanitize_component, save_json};
use crate::verify::{self, Check, CheckStatus, VerifyReport};
use anyhow::anyhow;
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, RANGE};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

const RUN: u8 = 0;
const PAUSE: u8 = 1;
const CANCEL: u8 = 2;
const STALL_SECS: u32 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Downloading,
    Paused,
    Verifying,
    Installing,
    Completed,
    Failed,
    Canceled,
}

impl JobState {
    fn is_active(self) -> bool {
        matches!(self, JobState::Queued | JobState::Downloading | JobState::Verifying | JobState::Installing | JobState::Paused)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub id: u64,
    pub product_id: String,
    pub product_name: String,
    pub tag: String,
    /// "install" | "update"
    pub purpose: String,
    pub asset: SelectedAsset,
    pub sums_url: Option<String>,
    pub sig_url: Option<String>,
    pub state: JobState,
    pub downloaded: u64,
    pub total: u64,
    /// Bytes per second, measured.
    pub speed: u64,
    pub resumed_from: u64,
    pub error: Option<String>,
    pub verification: Option<VerifyReport>,
    pub created_at: u64,
    pub finished_at: Option<u64>,
}

struct Slot {
    info: JobInfo,
    ctrl: Arc<AtomicU8>,
    running: bool,
}

#[derive(Default, Serialize, Deserialize)]
struct Persisted {
    next_id: u64,
    jobs: Vec<JobInfo>,
}

pub struct DownloadManager {
    slots: Mutex<Vec<Slot>>,
    next_id: AtomicU64,
    store: PathBuf,
}

enum End {
    Paused,
    Canceled,
    Failed(String),
}

impl<E: std::fmt::Display> From<E> for End {
    fn from(e: E) -> Self {
        End::Failed(e.to_string())
    }
}

impl DownloadManager {
    pub fn new(store: PathBuf) -> Self {
        Self { slots: Mutex::new(vec![]), next_id: AtomicU64::new(1), store }
    }

    /// Restore persisted jobs. Anything that was in flight comes back as paused (resumable).
    pub fn restore(&self) -> usize {
        let p: Persisted = load_json(&self.store);
        let mut slots = self.slots.lock().unwrap();
        let mut resumable = 0;
        for mut info in p.jobs {
            if matches!(info.state, JobState::Queued | JobState::Downloading | JobState::Verifying | JobState::Installing) {
                info.state = JobState::Paused;
                info.speed = 0;
            }
            if info.state == JobState::Paused {
                resumable += 1;
            }
            slots.push(Slot { info, ctrl: Arc::new(AtomicU8::new(RUN)), running: false });
        }
        let max_id = slots.iter().map(|s| s.info.id).max().unwrap_or(0);
        self.next_id.store(p.next_id.max(max_id + 1), Ordering::SeqCst);
        resumable
    }

    fn persist_locked(&self, slots: &[Slot]) {
        let p = Persisted {
            next_id: self.next_id.load(Ordering::SeqCst),
            jobs: slots.iter().map(|s| s.info.clone()).collect(),
        };
        let _ = save_json(&self.store, &p);
    }

    pub fn list(&self) -> Vec<JobInfo> {
        self.slots.lock().unwrap().iter().map(|s| s.info.clone()).collect()
    }

    pub fn has_active(&self, product_id: &str) -> bool {
        self.slots.lock().unwrap().iter().any(|s| s.info.product_id == product_id && s.info.state.is_active())
    }

    fn with<R>(&self, id: u64, persist: bool, f: impl FnOnce(&mut Slot) -> R) -> Option<R> {
        let mut slots = self.slots.lock().unwrap();
        let r = slots.iter_mut().find(|s| s.info.id == id).map(f);
        if persist {
            self.persist_locked(&slots);
        }
        r
    }

    fn info(&self, id: u64) -> Option<JobInfo> {
        self.with(id, false, |s| s.info.clone())
    }

    pub fn clear_finished(&self) {
        let mut slots = self.slots.lock().unwrap();
        slots.retain(|s| s.info.state.is_active() || s.running);
        self.persist_locked(&slots);
    }
}

fn emit(app: &AppHandle, info: &JobInfo) {
    let _ = app.emit("downloads://job", info);
}

fn part_path(core: &SharedCore, info: &JobInfo) -> PathBuf {
    core.paths.downloads.join(format!(
        "{}-{}-{}.part",
        sanitize_component(&info.product_id),
        sanitize_component(&info.tag),
        sanitize_component(&info.asset.name)
    ))
}

fn find_aux(release: &GhRelease, asset_name: &str) -> (Option<String>, Option<String>) {
    let sums = release
        .assets
        .iter()
        .find(|a| {
            let n = a.name.to_ascii_lowercase();
            n.contains("sha256sums") || n == "checksums.txt" || n.ends_with("checksums.sha256")
        })
        .map(|a| a.browser_download_url.clone());
    let sig_name = format!("{asset_name}.sig");
    let sig = release.assets.iter().find(|a| a.name == sig_name).map(|a| a.browser_download_url.clone());
    (sums, sig)
}

/// Queue an install (or update) of `product_id`. `tag = None` means the channel's latest.
pub async fn enqueue(core: &SharedCore, app: &AppHandle, product_id: &str, tag: Option<String>) -> anyhow::Result<u64> {
    crate::hub::ensure_not_busy(core, product_id)?;
    let (product, release, asset) = resolve_release(core, product_id, tag.as_deref()).await?;
    let installed = core.installed_app(product_id);
    if installed.as_ref().is_some_and(|a| a.versions.iter().any(|v| v.tag == release.tag_name)) {
        return Err(anyhow!("{} 已安裝；可在「已安裝」頁面切換", release.tag_name));
    }
    let (sums_url, sig_url) = find_aux(&release, &asset.name);
    let id = core.jobs.next_id.fetch_add(1, Ordering::SeqCst);
    let info = JobInfo {
        id,
        product_id: product.id.clone(),
        product_name: product.name.clone(),
        tag: release.tag_name.clone(),
        purpose: if installed.is_some() { "update".into() } else { "install".into() },
        total: asset.size,
        asset,
        sums_url,
        sig_url,
        state: JobState::Queued,
        downloaded: 0,
        speed: 0,
        resumed_from: 0,
        error: None,
        verification: None,
        created_at: now_secs(),
        finished_at: None,
    };
    {
        let mut slots = core.jobs.slots.lock().unwrap();
        slots.push(Slot { info: info.clone(), ctrl: Arc::new(AtomicU8::new(RUN)), running: false });
        core.jobs.persist_locked(&slots);
    }
    emit(app, &info);
    pump(core, app);
    Ok(id)
}

pub fn pause(core: &SharedCore, app: &AppHandle, id: u64) {
    if let Some(info) = core.jobs.with(id, true, |s| {
        if s.running {
            if s.info.state == JobState::Downloading {
                s.ctrl.store(PAUSE, Ordering::SeqCst);
            }
        } else if s.info.state == JobState::Queued {
            s.info.state = JobState::Paused;
        }
        s.info.clone()
    }) {
        emit(app, &info);
    }
}

pub fn resume(core: &SharedCore, app: &AppHandle, id: u64) {
    if let Some(info) = core.jobs.with(id, true, |s| {
        if !s.running && matches!(s.info.state, JobState::Paused | JobState::Failed) {
            s.info.state = JobState::Queued;
            s.info.error = None;
            s.ctrl.store(RUN, Ordering::SeqCst);
        }
        s.info.clone()
    }) {
        emit(app, &info);
    }
    pump(core, app);
}

pub fn cancel(core: &SharedCore, app: &AppHandle, id: u64) {
    let info = core.jobs.with(id, true, |s| {
        if s.running {
            if matches!(s.info.state, JobState::Downloading) {
                s.ctrl.store(CANCEL, Ordering::SeqCst);
            }
        } else if s.info.state.is_active() {
            s.info.state = JobState::Canceled;
            s.info.finished_at = Some(now_secs());
        }
        s.info.clone()
    });
    if let Some(info) = info {
        if info.state == JobState::Canceled {
            let _ = std::fs::remove_file(part_path(core, &info));
        }
        emit(app, &info);
    }
}

/// Start queued jobs while there is capacity.
pub fn pump(core: &SharedCore, app: &AppHandle) {
    let max = core.settings.read().unwrap().max_concurrent_downloads.max(1) as usize;
    let mut start = vec![];
    {
        let mut slots = core.jobs.slots.lock().unwrap();
        let mut running = slots.iter().filter(|s| s.running).count();
        for s in slots.iter_mut() {
            if running >= max {
                break;
            }
            if !s.running && s.info.state == JobState::Queued {
                s.running = true;
                s.info.state = JobState::Downloading;
                s.ctrl.store(RUN, Ordering::SeqCst);
                running += 1;
                start.push((s.info.id, s.ctrl.clone()));
            }
        }
    }
    for (id, ctrl) in start {
        let core = core.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move { run_job(core, app, id, ctrl).await });
    }
}

async fn run_job(core: SharedCore, app: AppHandle, id: u64, ctrl: Arc<AtomicU8>) {
    let outcome = process(&core, &app, id, &ctrl).await;
    let info = core.jobs.with(id, true, |s| {
        s.running = false;
        s.info.speed = 0;
        match &outcome {
            Ok(()) => {
                s.info.state = JobState::Completed;
                s.info.finished_at = Some(now_secs());
            }
            Err(End::Paused) => s.info.state = JobState::Paused,
            Err(End::Canceled) => {
                s.info.state = JobState::Canceled;
                s.info.finished_at = Some(now_secs());
            }
            Err(End::Failed(msg)) => {
                s.info.state = JobState::Failed;
                s.info.error = Some(msg.clone());
                s.info.finished_at = Some(now_secs());
            }
        }
        s.info.clone()
    });
    if let Some(info) = info {
        if info.state == JobState::Canceled {
            let _ = std::fs::remove_file(part_path(&core, &info));
        }
        emit(&app, &info);
        if info.state == JobState::Completed {
            core.notify_apps_changed(&app);
        }
    }
    pump(&core, &app);
}

fn set_state(core: &SharedCore, app: &AppHandle, id: u64, state: JobState) {
    if let Some(info) = core.jobs.with(id, true, |s| {
        s.info.state = state;
        s.info.speed = 0;
        s.info.clone()
    }) {
        emit(app, &info);
    }
}

async fn process(core: &SharedCore, app: &AppHandle, id: u64, ctrl: &Arc<AtomicU8>) -> Result<(), End> {
    let info = core.jobs.info(id).ok_or(End::Canceled)?;
    let file = download(core, app, &info, ctrl).await?;

    // ---- verification --------------------------------------------------------------
    set_state(core, app, id, JobState::Verifying);
    let product = core.product(&info.product_id)?.clone();
    let report = verify_download(core, &info, &product, &file).await?;
    core.jobs.with(id, true, |s| s.info.verification = Some(report.clone()));
    if report.any_failed() {
        // A corrupted or tampered file must not be resumed from — throw it away.
        let _ = std::fs::remove_file(&file);
        let why = [&report.github_digest, &report.checksum_file, &report.signature]
            .iter()
            .find(|c| c.status == CheckStatus::Failed)
            .map(|c| c.detail.clone())
            .unwrap_or_default();
        return Err(End::Failed(format!("驗證失敗，已刪除下載的檔案：{why}")));
    }

    // ---- installation --------------------------------------------------------------
    set_state(core, app, id, JobState::Installing);
    let apps_root = core.paths.apps.clone();
    let (pid, tag, asset, f2) = (info.product_id.clone(), info.tag.clone(), info.asset.clone(), file.clone());
    let (dir, launch) = tokio::task::spawn_blocking(move || install::install(&apps_root, &pid, &tag, &asset, &f2))
        .await
        .map_err(|e| End::Failed(e.to_string()))?
        .map_err(|e| End::Failed(format!("安裝失敗（原有版本未受影響）：{e:#}")))?;

    let keep = core.settings.read().unwrap().keep_previous_versions as usize;
    {
        let mut db = core.installed.lock().unwrap();
        let entry = db.apps.entry(info.product_id.clone()).or_insert_with(|| InstalledApp {
            product_id: info.product_id.clone(),
            current: info.tag.clone(),
            versions: vec![],
        });
        entry.versions.retain(|v| v.tag != info.tag);
        entry.versions.push(InstalledVersion {
            tag: info.tag.clone(),
            dir,
            launch,
            kind: info.asset.kind,
            asset_name: info.asset.name.clone(),
            size: info.total,
            verification: report,
            installed_at: now_secs(),
        });
        entry.current = info.tag.clone();
        prune_versions(entry, keep);
        let snapshot = db.clone();
        core.save_installed(&snapshot)?;
    }
    let _ = std::fs::remove_file(&file);

    if core.settings.read().unwrap().launch_after_install {
        let _ = crate::hub::launch_current(core, &info.product_id);
    }
    Ok(())
}

async fn fetch_text(core: &SharedCore, url: &str) -> anyhow::Result<String> {
    let resp = core.http.get(url).timeout(Duration::from_secs(30)).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow!("HTTP {}", resp.status().as_u16()));
    }
    Ok(resp.text().await?)
}

async fn verify_download(core: &SharedCore, info: &JobInfo, product: &crate::catalog::Product, file: &PathBuf) -> Result<VerifyReport, End> {
    let f = file.clone();
    let sha = tokio::task::spawn_blocking(move || verify::sha256_file(&f)).await.map_err(|e| End::Failed(e.to_string()))??;

    let github_digest = verify::check_github_digest(&sha, info.asset.digest.as_deref());
    let checksum_file = match &info.sums_url {
        Some(url) => match fetch_text(core, url).await {
            Ok(text) => verify::check_sums_file(&sha, Some(&text), &info.asset.name),
            Err(e) => Check::new(CheckStatus::Failed, format!("無法下載 SHA256SUMS：{e}")),
        },
        None => verify::check_sums_file(&sha, None, &info.asset.name),
    };
    let signature = match (&product.minisign_public_key, &info.sig_url) {
        (None, Some(_)) => Check::new(CheckStatus::NotConfigured, "發布附有簽章，但產品清單未設定公鑰，無法驗證"),
        (None, None) => Check::new(CheckStatus::NotConfigured, "此產品尚未設定發布簽章公鑰"),
        (Some(_), None) => Check::new(CheckStatus::Failed, "產品要求簽章，但此版本缺少 .sig 檔"),
        (Some(key), Some(url)) => match fetch_text(core, url).await {
            Ok(sig) => {
                let (key, f) = (key.clone(), file.clone());
                match tokio::task::spawn_blocking(move || verify::verify_minisign(&key, &sig, &f)).await {
                    Ok(Ok(())) => Check::new(CheckStatus::Passed, "minisign 簽章有效"),
                    Ok(Err(e)) => Check::new(CheckStatus::Failed, format!("簽章無效：{e}")),
                    Err(e) => Check::new(CheckStatus::Failed, e.to_string()),
                }
            }
            Err(e) => Check::new(CheckStatus::Failed, format!("無法下載簽章：{e}")),
        },
    };
    Ok(VerifyReport { sha256: sha, github_digest, checksum_file, signature })
}

async fn download(core: &SharedCore, app: &AppHandle, info: &JobInfo, ctrl: &Arc<AtomicU8>) -> Result<PathBuf, End> {
    let part = part_path(core, info);
    let total = info.total;
    let mut have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    if total > 0 && have > total {
        have = 0;
        let _ = tokio::fs::remove_file(&part).await;
    }
    if total > 0 && have == total {
        core.jobs.with(info.id, false, |s| s.info.downloaded = have);
        return Ok(part);
    }

    let mut req = core.http.get(&info.asset.url).header(ACCEPT, "application/octet-stream");
    if have > 0 {
        req = req.header(RANGE, format!("bytes={have}-"));
    }
    let resp = req.send().await.map_err(|e| End::Failed(format!("下載失敗：{}", crate::github::short_err(&e))))?;
    let status = resp.status();
    let mut file = if status == StatusCode::PARTIAL_CONTENT && have > 0 {
        tokio::fs::OpenOptions::new().append(true).open(&part).await?
    } else if status.is_success() {
        have = 0; // server ignored the range: start over
        tokio::fs::File::create(&part).await?
    } else if status == StatusCode::RANGE_NOT_SATISFIABLE {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(End::Failed("伺服器拒絕續傳，已清除暫存檔，請按「重試」重新下載".into()));
    } else {
        return Err(End::Failed(format!("下載失敗：HTTP {}", status.as_u16())));
    };

    let resumed_from = have;
    let mut stream = resp.bytes_stream();
    let mut last_emit = Instant::now();
    let mut last_bytes = have;
    let mut speed: f64 = 0.0;
    let mut idle = 0u32;
    core.jobs.with(info.id, false, |s| {
        s.info.resumed_from = resumed_from;
        s.info.downloaded = have;
    });

    loop {
        match ctrl.load(Ordering::SeqCst) {
            PAUSE => {
                file.flush().await?;
                return Err(End::Paused);
            }
            CANCEL => return Err(End::Canceled),
            _ => {}
        }
        let next = match tokio::time::timeout(Duration::from_secs(1), stream.next()).await {
            Err(_) => {
                idle += 1;
                if idle >= STALL_SECS {
                    file.flush().await?;
                    return Err(End::Failed("下載停滯超過 60 秒，可按「重試」從中斷處繼續".into()));
                }
                continue;
            }
            Ok(n) => n,
        };
        idle = 0;
        match next {
            None => break,
            Some(Err(e)) => {
                file.flush().await?;
                return Err(End::Failed(format!("連線中斷：{}，可按「重試」從中斷處繼續", crate::github::short_err(&e))));
            }
            Some(Ok(chunk)) => {
                file.write_all(&chunk).await?;
                have += chunk.len() as u64;
            }
        }
        let dt = last_emit.elapsed();
        if dt >= Duration::from_millis(250) {
            let inst = (have - last_bytes) as f64 / dt.as_secs_f64();
            speed = if speed == 0.0 { inst } else { speed * 0.7 + inst * 0.3 };
            last_emit = Instant::now();
            last_bytes = have;
            if let Some(i) = core.jobs.with(info.id, false, |s| {
                s.info.downloaded = have;
                s.info.speed = speed as u64;
                s.info.clone()
            }) {
                emit(app, &i);
            }
        }
    }
    file.flush().await?;
    drop(file);
    if total > 0 && have != total {
        return Err(End::Failed(format!("下載不完整（{have}/{total} 位元組），可按「重試」繼續")));
    }
    if let Some(i) = core.jobs.with(info.id, true, |s| {
        s.info.downloaded = have;
        s.info.clone()
    }) {
        emit(app, &i);
    }
    Ok(part)
}
