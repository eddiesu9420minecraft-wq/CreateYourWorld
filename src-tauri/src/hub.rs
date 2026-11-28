//! Shared application state and the product / installed-app views served to the UI.

use crate::catalog::Product;
use crate::downloads::DownloadManager;
use crate::github::{classify, compare_tags, Channel, GhRelease, GithubClient};
use crate::install::{self, InstalledApp, InstalledDb};
use crate::paths::Paths;
use crate::platform::{select_asset, Platform, SelectedAsset};
use crate::runtime::HardwareReport;
use crate::settings::Settings;
use crate::util::save_json;
use anyhow::{anyhow, bail};
use pikara_secure::doh::DohResolver;
use pikara_secure::net::{self, ClientOptions};
use serde::Serialize;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct Core {
    pub paths: Paths,
    pub catalog: Vec<Product>,
    pub platform: Platform,
    /// Download client (no overall timeout). DoH + HTTPS-only + allow-list.
    pub http: reqwest::Client,
    /// Small-request client (20 s timeout). Same security properties.
    pub api_http: reqwest::Client,
    pub resolver: DohResolver,
    pub github: GithubClient,
    pub selfupdate: crate::selfupdate::SelfUpdater,
    /// Products whose update waits for the user to quit the running app.
    pub pending_updates: Mutex<std::collections::BTreeSet<String>>,
    pub settings: RwLock<Settings>,
    pub installed: Mutex<InstalledDb>,
    pub jobs: DownloadManager,
    pub hardware: tokio::sync::OnceCell<HardwareReport>,
    /// Last PATH-sync problem per product (shown on the product; cleared when a sync succeeds).
    pub cli_problems: Mutex<std::collections::BTreeMap<String, String>>,
}

pub type SharedCore = Arc<Core>;

impl Core {
    pub fn new(paths: Paths) -> anyhow::Result<Self> {
        // Pikara Secure Network: DoH-only resolution, HTTPS-only, allow-listed GitHub hosts.
        let resolver = DohResolver::default();
        let ua = concat!("CreateYourWorld/", env!("CARGO_PKG_VERSION")).to_string();
        let http = net::secure_client(resolver.clone(), ClientOptions { allowed_hosts: net::GITHUB_HOSTS, user_agent: ua.clone(), timeout: None })?;
        let api_http = net::secure_client(resolver.clone(), ClientOptions { allowed_hosts: net::GITHUB_HOSTS, user_agent: ua, timeout: Some(Duration::from_secs(20)) })?;
        Ok(Self {
            github: GithubClient::new(api_http.clone(), paths.cache.clone()),
            api_http,
            resolver,
            selfupdate: crate::selfupdate::SelfUpdater::new(),
            pending_updates: Mutex::new(std::collections::BTreeSet::new()),
            jobs: DownloadManager::new(paths.jobs_file()),
            catalog: crate::catalog::load(),
            platform: Platform::detect(),
            settings: RwLock::new(Settings::default()),
            installed: Mutex::new(InstalledDb::default()),
            hardware: tokio::sync::OnceCell::new(),
            cli_problems: Mutex::new(Default::default()),
            http,
            paths,
        })
    }

    pub fn product(&self, id: &str) -> anyhow::Result<&Product> {
        self.catalog.iter().find(|p| p.id == id).ok_or_else(|| anyhow!("未知的產品：{id}"))
    }

    pub fn save_installed(&self, db: &InstalledDb) -> anyhow::Result<()> {
        save_json(&self.paths.installed_file(), db)?;
        // every install / update / switch / rollback / uninstall passes here: keep PATH copies current
        let problems = crate::cli_path::sync(&self.paths, &self.catalog, db);
        let mut m = self.cli_problems.lock().unwrap();
        m.clear();
        for (id, msg) in problems {
            m.insert(id, msg);
        }
        Ok(())
    }

    /// The release channel for a product: the user's choice, else the catalog default, else the global default.
    pub fn channel_for(&self, p: &Product) -> Channel {
        let s = self.settings.read().unwrap();
        match s.channels.get(&p.id) {
            Some(c) => *c,
            None => p.default_channel.unwrap_or(s.default_channel),
        }
    }

    pub fn installed_app(&self, id: &str) -> Option<InstalledApp> {
        self.installed.lock().unwrap().apps.get(id).cloned()
    }

    pub fn notify_apps_changed(&self, app: &AppHandle) {
        let _ = app.emit("apps://changed", ());
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseView {
    pub tag: String,
    pub name: String,
    pub channel: Channel,
    pub published_at: Option<String>,
    pub html_url: String,
    pub notes: String,
    pub asset: Option<SelectedAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductView {
    pub id: String,
    pub name: String,
    pub tagline: String,
    pub description: String,
    pub glyph: Option<String>,
    pub repo: Option<String>,
    /// "available" | "in-development" | "no-platform-build" | "offline"
    pub status: &'static str,
    pub channel: Channel,
    /// Releases visible in the selected channel, newest first.
    pub releases: Vec<ReleaseView>,
    pub latest: Option<ReleaseView>,
    pub installed: Option<InstalledApp>,
    pub update: Option<ReleaseView>,
    pub warning: Option<String>,
    pub fetched_at: Option<u64>,
    pub source: Option<&'static str>,
    pub signing: bool,
    /// Update deferred until the app is closed.
    pub pending_update: bool,
    pub running: bool,
    pub category: crate::catalog::Category,
    /// Command-line binary name (`runxc.exe`) for developer tools; `None` for apps with a window.
    pub cli: Option<String>,
    pub on_path: bool,
    pub path_problem: Option<String>,
}

fn release_view(p: &Product, r: &GhRelease, plat: &Platform) -> ReleaseView {
    ReleaseView {
        tag: r.tag_name.clone(),
        name: r.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| r.tag_name.clone()),
        channel: classify(r),
        published_at: r.published_at.clone(),
        html_url: r.html_url.clone(),
        notes: r.body.clone().unwrap_or_default(),
        asset: select_asset(p, r, plat),
    }
}

pub async fn product_views(core: &SharedCore, force: bool) -> Vec<ProductView> {
    let futures = core.catalog.iter().map(|p| {
        let core = core.clone();
        let p = p.clone();
        async move { product_view(&core, &p, force).await }
    });
    futures_util::future::join_all(futures).await
}

pub async fn product_view(core: &SharedCore, p: &Product, force: bool) -> ProductView {
    let channel = core.channel_for(p);
    let installed = core.installed_app(&p.id);
    let cli_problem = {
        let m = core.cli_problems.lock().unwrap();
        m.get(&p.id).or_else(|| m.get("")).cloned()
    };
    let mut view = ProductView {
        id: p.id.clone(),
        name: p.name.clone(),
        tagline: p.tagline.clone(),
        description: p.description.clone(),
        glyph: p.glyph.clone(),
        repo: p.repo.clone(),
        status: "in-development",
        channel,
        releases: vec![],
        latest: None,
        installed,
        update: None,
        warning: None,
        fetched_at: None,
        source: None,
        signing: p.minisign_public_key.is_some(),
        pending_update: core.pending_updates.lock().unwrap().contains(&p.id),
        running: is_running(core, &p.id),
        category: p.category,
        cli: crate::cli_path::binary_name(p),
        on_path: installed_on_path(core, p),
        path_problem: if p.cli.is_some() { cli_problem } else { None },
    };
    let Some(repo) = &p.repo else { return view };

    let result = match core.github.releases(repo, force).await {
        Ok(r) => r,
        Err(e) => {
            view.status = "offline";
            view.warning = Some(e.to_string());
            return view;
        }
    };
    view.warning = result.warning;
    view.fetched_at = Some(result.fetched_at);
    view.source = Some(result.source);
    if result.releases.is_empty() {
        return view; // in development: nothing published yet
    }

    let mut releases: Vec<ReleaseView> = result
        .releases
        .iter()
        .map(|r| release_view(p, r, &core.platform))
        .filter(|r| channel.includes(r.channel))
        .collect();
    releases.sort_by(|a, b| compare_tags(&b.tag, &a.tag));
    view.latest = releases.iter().find(|r| r.asset.is_some()).cloned();
    view.status = if view.latest.is_some() { "available" } else { "no-platform-build" };
    if let (Some(inst), Some(latest)) = (&view.installed, &view.latest) {
        if compare_tags(&latest.tag, &inst.current).is_gt() {
            view.update = Some(latest.clone());
        }
    }
    view.releases = releases;
    view
}

/// Find a specific release (or the channel's latest) together with its asset for this machine.
pub async fn resolve_release(core: &SharedCore, product_id: &str, tag: Option<&str>) -> anyhow::Result<(Product, GhRelease, SelectedAsset)> {
    let p = core.product(product_id)?.clone();
    let repo = p.repo.clone().ok_or_else(|| anyhow!("{} 仍在開發中，尚無發布版本", p.name))?;
    let rr = core.github.releases(&repo, false).await?;
    let channel = core.channel_for(&p);
    let release = match tag {
        Some(t) => rr.releases.into_iter().find(|r| r.tag_name == t).ok_or_else(|| anyhow!("找不到版本 {t}"))?,
        None => {
            let mut rs: Vec<GhRelease> = rr
                .releases
                .into_iter()
                .filter(|r| channel.includes(classify(r)) && select_asset(&p, r, &core.platform).is_some())
                .collect();
            rs.sort_by(|a, b| compare_tags(&b.tag_name, &a.tag_name));
            rs.into_iter().next().ok_or_else(|| anyhow!("此平台目前沒有可用的發布版本"))?
        }
    };
    let asset = select_asset(&p, &release, &core.platform)
        .ok_or_else(|| anyhow!("{} 沒有適用於 {} 的檔案", release.tag_name, core.platform.key()))?;
    Ok((p, release, asset))
}

pub fn launch_current(core: &Core, product_id: &str) -> anyhow::Result<()> {
    if let Some(bin) = crate::cli_path::binary_name(core.product(product_id)?) {
        bail!("這是命令列工具，沒有視窗可以開啟：請在終端機執行 {bin}（可先「加入 PATH」）");
    }
    let app = core.installed_app(product_id).ok_or_else(|| anyhow!("尚未安裝"))?;
    let v = app.current_version().ok_or_else(|| anyhow!("安裝資料損毀：找不到目前版本"))?;
    install::launch(&v.launch)
}

pub fn uninstall(core: &Core, product_id: &str) -> anyhow::Result<()> {
    if is_running(core, product_id) {
        bail!("應用程式正在執行，請先關閉後再解除安裝");
    }
    let mut db = core.installed.lock().unwrap();
    let app = db.apps.get(product_id).cloned().ok_or_else(|| anyhow!("尚未安裝"))?;
    for v in &app.versions {
        install::uninstall_dir(&v.dir, v.kind)?;
    }
    let pdir = install::product_dir(&core.paths.apps, product_id);
    if pdir.exists() {
        let _ = std::fs::remove_dir_all(&pdir);
    }
    db.apps.remove(product_id);
    core.save_installed(&db)
}

/// Make an already-installed version current (no download). Returns false if it isn't kept on disk.
pub fn switch_to(core: &Core, product_id: &str, tag: &str) -> anyhow::Result<bool> {
    let mut db = core.installed.lock().unwrap();
    let Some(app) = db.apps.get_mut(product_id) else { return Ok(false) };
    if !app.versions.iter().any(|v| v.tag == tag && v.launch.exists()) {
        return Ok(false);
    }
    app.current = tag.to_string();
    let snapshot = db.clone();
    core.save_installed(&snapshot)?;
    Ok(true)
}

/// Switch back to the most recent previous version that is still on disk.
pub fn rollback(core: &Core, product_id: &str) -> anyhow::Result<String> {
    let mut db = core.installed.lock().unwrap();
    let app = db.apps.get_mut(product_id).ok_or_else(|| anyhow!("尚未安裝"))?;
    let cur = app.current.clone();
    let target = app
        .versions
        .iter()
        .filter(|v| v.tag != cur && v.launch.exists())
        .max_by(|a, b| compare_tags(&a.tag, &b.tag))
        .map(|v| v.tag.clone())
        .ok_or_else(|| anyhow!("沒有可回復的舊版本"))?;
    app.current = target.clone();
    let snapshot = db.clone();
    core.save_installed(&snapshot)?;
    Ok(target)
}

/// Remove versions beyond the retention setting (never the current one).
pub fn prune_versions(app: &mut InstalledApp, keep_previous: usize) {
    let cur = app.current.clone();
    app.versions.sort_by(|a, b| compare_tags(&b.tag, &a.tag));
    let mut kept = 0;
    let mut remove = vec![];
    for v in &app.versions {
        if v.tag == cur {
            continue;
        }
        if kept < keep_previous {
            kept += 1;
        } else {
            remove.push(v.clone());
        }
    }
    for v in remove {
        if crate::procs::running_under(&v.dir) {
            continue; // still in use: keep it, prune on a later update
        }
        if install::uninstall_dir(&v.dir, v.kind).is_ok() {
            app.versions.retain(|x| x.tag != v.tag);
        }
    }
}

/// At startup: drop records whose files vanished, and clean stale staging dirs.
pub fn verify_installed(core: &Core) -> usize {
    let mut db = core.installed.lock().unwrap();
    let mut broken = 0;
    for app in db.apps.values_mut() {
        let before = app.versions.len();
        app.versions.retain(|v| v.launch.exists());
        broken += before - app.versions.len();
        if app.current_version().is_none() {
            if let Some(v) = app.versions.iter().max_by(|a, b| compare_tags(&a.tag, &b.tag)) {
                app.current = v.tag.clone();
            }
        }
        let pdir = install::product_dir(&core.paths.apps, &app.product_id);
        if let Ok(rd) = std::fs::read_dir(&pdir) {
            for e in rd.filter_map(|e| e.ok()) {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with(".staging-") || n.starts_with(".replaced-") {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
    }
    db.apps.retain(|_, a| !a.versions.is_empty());
    if broken > 0 {
        let snapshot = db.clone();
        let _ = core.save_installed(&snapshot);
    }
    broken
}

/// Is any installed version of this product currently running?
/// The tool is on PATH: the user enabled it and `<data>/bin` is registered.
fn installed_on_path(core: &Core, p: &Product) -> bool {
    p.cli.is_some() && core.installed_app(&p.id).is_some_and(|a| a.on_path) && crate::cli_path::registered(&core.paths)
}

/// Put a command-line tool on the user's PATH (or take it off). Returns the problem, if any.
pub fn set_on_path(core: &Core, product_id: &str, enabled: bool) -> anyhow::Result<Option<String>> {
    if core.product(product_id)?.cli.is_none() {
        bail!("這個產品不是命令列工具");
    }
    let mut db = core.installed.lock().unwrap();
    let app = db.apps.get_mut(product_id).ok_or_else(|| anyhow!("尚未安裝"))?;
    app.on_path = enabled;
    let snapshot = db.clone();
    core.save_installed(&snapshot)?;
    let m = core.cli_problems.lock().unwrap();
    Ok(m.get(product_id).or_else(|| m.get("")).cloned())
}

pub fn is_running(core: &Core, product_id: &str) -> bool {
    core.installed_app(product_id).is_some() && crate::procs::running_under(&install::product_dir(&core.paths.apps, product_id))
}

pub fn ensure_not_busy(core: &Core, product_id: &str) -> anyhow::Result<()> {
    if core.jobs.has_active(product_id) {
        bail!("此應用程式已有進行中的工作");
    }
    Ok(())
}
