//! Plugin Manager — shared by the GUI and `cyw` (SDK / manifest spec: docs/plugin-sdk.md).
//!
//! Trust model
//! * Each package that supports plugins publishes a **plugin index** (`plugins.json`) plus a minisign signature
//!   (`plugins.json.sig`) made with the Pikara release key compiled into CYW. An index that is unsigned, signed
//!   with another key, malformed, or declares another software is rejected.
//! * The signed index pins every plugin package's SHA-256 and size; downloads are verified against it (and
//!   against a package `.sig` when one is published). URLs must be HTTPS on the GitHub allow-list and are
//!   fetched through Pikara Secure Network (DoH, no system DNS).
//! * Packages are extracted with the same traversal-safe extractor as apps into a staging folder, then moved
//!   into place; any failure deletes the staging folder and leaves the previous version untouched.
//! * Plugins are files only. CYW never runs scripts from a plugin; an index entry that declares `scripts` is
//!   refused unless the user explicitly allows it, and even then CYW only records them for the host app.
//! * Every plugin declares the permissions it needs; nothing grants administrator rights.
//! * Compatibility (`requires.software`), dependencies (resolved within the same index) and conflicts are
//!   checked before anything is downloaded.

use crate::catalog::Product;
use crate::hub::Core;
use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub const SCHEMA: u32 = 1;

/// Permissions a plugin may declare. Unknown permissions make the index invalid.
pub const KNOWN_PERMISSIONS: &[(&str, &str)] = &[
    ("files:plugin", "讀寫自己的外掛資料夾"),
    ("files:project", "讀寫使用者目前開啟的專案"),
    ("files:user", "讀寫使用者選擇的檔案"),
    ("network", "連線到網路"),
    ("gpu", "使用 GPU"),
    ("process", "啟動其他程式"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Index {
    pub schema: u32,
    /// Full product name of the host software (must equal the catalog id).
    pub software: String,
    pub plugins: Vec<PluginEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginEntry {
    /// Unique within the index; letters, digits, `.`, `-`, `_`.
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub versions: Vec<PluginVersion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginVersion {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    /// Semver requirement on the host software version, e.g. `>=0.1.0-alpha`.
    #[serde(default)]
    pub requires: Option<String>,
    /// Other plugins of the same software: id → semver requirement.
    #[serde(default)]
    pub dependencies: BTreeMap<String, String>,
    /// Plugins that must not be enabled at the same time.
    #[serde(default)]
    pub conflicts: Vec<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Declared install scripts. CYW never runs them automatically.
    #[serde(default)]
    pub scripts: Vec<String>,
}

/// The shared plugin database (`<data>/plugins.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginDb {
    #[serde(default)]
    pub software: BTreeMap<String, BTreeMap<String, InstalledPlugin>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub current: String,
    /// Installed versions (kept for rollback), newest last.
    pub versions: Vec<String>,
    pub enabled: bool,
    pub permissions: Vec<String>,
    pub sha256: String,
    pub installed_at: u64,
}

fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) && !s.starts_with('.') && !s.contains("..")
}

fn parse_ver(v: &str) -> anyhow::Result<semver::Version> {
    semver::Version::parse(v.trim_start_matches('v')).with_context(|| format!("版本格式錯誤：{v}"))
}

/// Structural validation of a (signature-checked) index.
pub fn validate(index: &Index, software: &str) -> anyhow::Result<()> {
    if index.schema != SCHEMA {
        bail!("外掛索引格式版本 {} 不受支援", index.schema);
    }
    if !index.software.eq_ignore_ascii_case(software) {
        bail!("外掛索引宣告的軟體是 {}，不是 {software}（拒絕使用）", index.software);
    }
    let mut ids = BTreeSet::new();
    for p in &index.plugins {
        if !valid_id(&p.id) {
            bail!("外掛 ID 不合法：{:?}", p.id);
        }
        if !ids.insert(p.id.to_ascii_lowercase()) {
            bail!("外掛 ID 重複：{}", p.id);
        }
        for v in &p.versions {
            parse_ver(&v.version)?;
            if v.sha256.len() != 64 || !v.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
                bail!("{} {}：SHA-256 格式錯誤", p.id, v.version);
            }
            pikara_secure::net::check_url(&v.url, pikara_secure::net::GITHUB_HOSTS).map_err(|e| anyhow!("{} {}：下載網址不被允許：{e}", p.id, v.version))?;
            if let Some(r) = &v.requires {
                semver::VersionReq::parse(r).with_context(|| format!("{} {}：requires 格式錯誤", p.id, v.version))?;
            }
            for (d, r) in &v.dependencies {
                if !valid_id(d) {
                    bail!("{}：相依外掛 ID 不合法 {d:?}", p.id);
                }
                semver::VersionReq::parse(r).with_context(|| format!("{}：相依版本範圍格式錯誤", p.id))?;
            }
            for perm in &v.permissions {
                if !KNOWN_PERMISSIONS.iter().any(|(k, _)| k == perm) {
                    bail!("{} {}：未知的權限 {perm}", p.id, v.version);
                }
            }
        }
    }
    Ok(())
}

/// Verify the signature of an index document with the compiled-in Pikara key, then parse and validate it.
pub fn verify_index(bytes: &[u8], sig: &str, software: &str, pubkey: &str, scratch: &Path) -> anyhow::Result<Index> {
    std::fs::create_dir_all(scratch)?;
    // unique per call: concurrent verifications in one process must not share a temp file
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = scratch.join(format!("index-{}-{}-{n}.json", crate::util::sanitize_component(software), std::process::id()));
    std::fs::write(&tmp, bytes)?;
    let sha = hex::encode(Sha256::digest(bytes));
    let r = pikara_secure::artifact::verify_file(&tmp, &sha, sig, pubkey);
    let _ = std::fs::remove_file(&tmp);
    r.map_err(|e| anyhow!("外掛索引簽章驗證失敗（拒絕使用）：{e}"))?;
    let index: Index = serde_json::from_slice(bytes).map_err(|e| anyhow!("外掛索引格式錯誤（拒絕使用）：{e}"))?;
    validate(&index, software)?;
    Ok(index)
}

/// Download and verify the index of one software. `Ok(None)` when it publishes none.
pub async fn fetch_index(core: &Core, p: &Product) -> anyhow::Result<Option<Index>> {
    let Some(url) = &p.plugin_index else { return Ok(None) };
    let body = pikara_secure::net::fetch_small(&core.api_http, url, pikara_secure::net::GITHUB_HOSTS, 2 * 1024 * 1024).await.map_err(|e| anyhow!("{}：無法下載外掛索引：{e}", p.id))?;
    let sig = pikara_secure::net::fetch_small(&core.api_http, &format!("{url}.sig"), pikara_secure::net::GITHUB_HOSTS, 64 * 1024).await.map_err(|e| anyhow!("{}：外掛索引沒有簽章（拒絕使用）：{e}", p.id))?;
    let sig = String::from_utf8(sig).map_err(|_| anyhow!("簽章格式錯誤"))?;
    verify_index(&body, &sig, &p.id, pikara_secure::keys::PIKARA_RELEASE_PUBKEY, &core.paths.cache).map(Some)
}

pub fn db_file(core: &Core) -> PathBuf {
    core.paths.data.join("plugins.json")
}

pub fn plugin_root(core: &Core, software: &str) -> PathBuf {
    core.paths.data.join("plugins").join(crate::util::sanitize_component(software))
}

/// Read-modify-write the plugin DB under the shared state lock; also refreshes each software's `enabled.json`.
pub fn modify_db<R>(core: &Core, f: impl FnOnce(&mut PluginDb) -> anyhow::Result<R>) -> anyhow::Result<R> {
    let _g = crate::lock::state(&core.paths)?;
    let mut db: PluginDb = crate::util::load_json(&db_file(core));
    let r = f(&mut db)?;
    crate::util::save_json(&db_file(core), &db)?;
    for (sw, plugins) in &db.software {
        let enabled: Vec<_> = plugins
            .values()
            .filter(|p| p.enabled)
            .map(|p| serde_json::json!({"id": p.id, "version": p.current, "dir": plugin_root(core, sw).join(&p.id).join(&p.current), "permissions": p.permissions}))
            .collect();
        let _ = crate::util::save_json(&plugin_root(core, sw).join("enabled.json"), &serde_json::json!({"schema": SCHEMA, "software": sw, "plugins": enabled}));
    }
    Ok(r)
}

pub fn load_db(core: &Core) -> PluginDb {
    crate::util::load_json(&db_file(core))
}

/// Installed version of the host software as semver (tags like `v0.3.4`).
fn software_version(core: &Core, software: &str) -> Option<semver::Version> {
    core.installed_app(software).and_then(|a| crate::github::parse_version(&a.current))
}

/// One step of an install plan.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub permissions: Vec<String>,
    pub scripts: Vec<String>,
    /// Already installed at this version (nothing to download).
    pub present: bool,
}

/// Resolve `id` (optionally at `version`) plus its dependencies into an ordered plan (dependencies first),
/// checking compatibility with the installed software and conflicts with enabled plugins.
pub fn plan(index: &Index, db: &PluginDb, software_ver: Option<&semver::Version>, id: &str, version: Option<&str>) -> anyhow::Result<Vec<Step>> {
    let installed = db.software.get(&index.software).cloned().unwrap_or_default();
    let mut out: Vec<Step> = vec![];
    let mut visiting = BTreeSet::new();
    fn pick<'a>(index: &'a Index, id: &str, req: Option<&semver::VersionReq>, exact: Option<&str>, sw: Option<&semver::Version>) -> anyhow::Result<(&'a PluginEntry, &'a PluginVersion)> {
        let e = index.plugins.iter().find(|p| p.id.eq_ignore_ascii_case(id)).ok_or_else(|| anyhow!("{} 沒有名為 {id} 的外掛", index.software))?;
        let mut cands: Vec<&PluginVersion> = e.versions.iter().collect();
        cands.sort_by(|a, b| parse_ver(&b.version).ok().cmp(&parse_ver(&a.version).ok()));
        let compatible = |v: &&PluginVersion| match (&v.requires, sw) {
            (Some(r), Some(s)) => semver::VersionReq::parse(r).map(|r| r.matches(s)).unwrap_or(false),
            (Some(_), None) => false,
            (None, _) => true,
        };
        let chosen = cands
            .into_iter()
            .filter(|v| exact.map(|x| parse_ver(x).ok() == parse_ver(&v.version).ok()).unwrap_or(true))
            .filter(|v| req.map(|r| parse_ver(&v.version).map(|x| r.matches(&x)).unwrap_or(false)).unwrap_or(true))
            .find(compatible);
        match chosen {
            Some(v) => Ok((e, v)),
            None => {
                let need = exact.map(String::from).or(req.map(|r| r.to_string())).unwrap_or_else(|| "任何版本".into());
                bail!("{id}（{need}）沒有與已安裝的 {} {} 相容的版本", index.software, sw.map(|s| s.to_string()).unwrap_or_else(|| "（未安裝）".into()))
            }
        }
    }
    fn visit(index: &Index, installed: &BTreeMap<String, InstalledPlugin>, sw: Option<&semver::Version>, id: &str, req: Option<&semver::VersionReq>, exact: Option<&str>, out: &mut Vec<Step>, visiting: &mut BTreeSet<String>) -> anyhow::Result<()> {
        let key = id.to_ascii_lowercase();
        if out.iter().any(|s| s.id.eq_ignore_ascii_case(id)) {
            return Ok(());
        }
        if !visiting.insert(key.clone()) {
            bail!("外掛相依關係形成循環：{id}");
        }
        let (e, v) = pick(index, id, req, exact, sw)?;
        for (dep, r) in &v.dependencies {
            let r = semver::VersionReq::parse(r)?;
            // a dependency already installed at a matching version is kept
            if let Some(ip) = installed.get(dep).or_else(|| installed.values().find(|p| p.id.eq_ignore_ascii_case(dep))) {
                if parse_ver(&ip.current).map(|x| r.matches(&x)).unwrap_or(false) {
                    continue;
                }
            }
            visit(index, installed, sw, dep, Some(&r), None, out, visiting)?;
        }
        let present = installed.values().any(|p| p.id.eq_ignore_ascii_case(&e.id) && p.current == v.version);
        out.push(Step { id: e.id.clone(), version: v.version.clone(), url: v.url.clone(), sha256: v.sha256.to_ascii_lowercase(), size: v.size, permissions: v.permissions.clone(), scripts: v.scripts.clone(), present });
        visiting.remove(&key);
        Ok(())
    }
    visit(index, &installed, software_ver, id, None, version, &mut out, &mut visiting)?;
    // enabled plugins that depend on a plugin in the plan must still be satisfied (no silent downgrade)
    for s in &out {
        if let Some(by) = broken_dependent(index, &installed, &s.id, &s.version) {
            bail!("{by}；不會安裝 {} {}", s.id, s.version);
        }
    }
    // conflicts, both directions, against enabled plugins and the rest of the plan
    for s in &out {
        let v = index.plugins.iter().find(|p| p.id == s.id).and_then(|p| p.versions.iter().find(|v| v.version == s.version)).unwrap();
        for c in &v.conflicts {
            if installed.values().any(|p| p.enabled && p.id.eq_ignore_ascii_case(c)) || out.iter().any(|o| o.id.eq_ignore_ascii_case(c)) {
                bail!("{} 與已啟用的外掛 {c} 衝突；請先停用 {c}", s.id);
            }
        }
        for p in installed.values().filter(|p| p.enabled) {
            let theirs = index.plugins.iter().find(|e| e.id.eq_ignore_ascii_case(&p.id)).and_then(|e| e.versions.iter().find(|v| v.version == p.current));
            if theirs.is_some_and(|t| t.conflicts.iter().any(|c| c.eq_ignore_ascii_case(&s.id))) {
                bail!("已啟用的外掛 {} 與 {} 衝突；請先停用 {}", p.id, s.id, p.id);
            }
        }
    }
    Ok(out)
}

/// Would putting `id` at `version` break an enabled plugin that depends on it? Returns the reason.
fn broken_dependent(index: &Index, installed: &BTreeMap<String, InstalledPlugin>, id: &str, version: &str) -> Option<String> {
    let ver = parse_ver(version).ok()?;
    for p in installed.values().filter(|p| p.enabled && !p.id.eq_ignore_ascii_case(id)) {
        let deps = index.plugins.iter().find(|e| e.id.eq_ignore_ascii_case(&p.id)).and_then(|e| e.versions.iter().find(|v| v.version == p.current)).map(|v| v.dependencies.clone()).unwrap_or_default();
        for (d, r) in deps {
            if d.eq_ignore_ascii_case(id) && semver::VersionReq::parse(&r).is_ok_and(|r| !r.matches(&ver)) {
                return Some(format!("已啟用的 {} {} 需要 {id} {r}", p.id, p.current));
            }
        }
    }
    None
}

/// Download, verify and install one plan step (into `<data>/plugins/<software>/<id>/<version>`).
pub async fn install_step(core: &Core, software: &str, step: &Step) -> anyhow::Result<()> {
    if step.present {
        return Ok(());
    }
    pikara_secure::net::check_url(&step.url, pikara_secure::net::GITHUB_HOSTS).map_err(|e| anyhow!("下載網址不被允許：{e}"))?;
    let root = plugin_root(core, software);
    let dest = root.join(&step.id).join(&step.version);
    let staging = root.join(&step.id).join(format!(".staging-{}", std::process::id()));
    let dl = core.paths.downloads.join(format!("plugin-{}-{}-{}", crate::util::sanitize_component(software), step.id, step.version));
    let res: anyhow::Result<()> = async {
        // download through the secure client (DoH, HTTPS-only, allow-listed hosts, checked redirects)
        let resp = core.http.get(&step.url).send().await.map_err(|e| anyhow!("下載失敗：{e}"))?;
        if !resp.status().is_success() {
            bail!("下載失敗：HTTP {}", resp.status());
        }
        let bytes = resp.bytes().await.map_err(|e| anyhow!("下載失敗：{e}"))?;
        if bytes.len() as u64 != step.size {
            bail!("檔案大小不符：預期 {} bytes，實際 {} bytes", step.size, bytes.len());
        }
        let actual = hex::encode(Sha256::digest(&bytes));
        if actual != step.sha256 {
            bail!("SHA-256 不符（預期 {}，實際 {actual}）；檔案已刪除", step.sha256);
        }
        std::fs::create_dir_all(dl.parent().unwrap())?;
        std::fs::write(&dl, &bytes)?;
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging)?;
        let name = step.url.rsplit('/').next().unwrap_or("plugin.zip").to_string();
        crate::archive::extract_any(&dl, &name, &staging)?;
        if dest.exists() {
            std::fs::remove_dir_all(&dest)?;
        }
        std::fs::rename(&staging, &dest)?;
        Ok(())
    }
    .await;
    let _ = std::fs::remove_file(&dl);
    if res.is_err() {
        let _ = std::fs::remove_dir_all(&staging); // previous versions are untouched
    }
    res
}

/// Record installed steps (current = installed version, enabled).
pub fn record(core: &Core, software: &str, steps: &[Step]) -> anyhow::Result<()> {
    modify_db(core, |db| {
        let m = db.software.entry(software.to_string()).or_default();
        for s in steps {
            let e = m.entry(s.id.clone()).or_insert_with(|| InstalledPlugin { id: s.id.clone(), current: s.version.clone(), versions: vec![], enabled: true, permissions: vec![], sha256: String::new(), installed_at: 0 });
            if !e.versions.contains(&s.version) {
                e.versions.push(s.version.clone());
            }
            e.versions.sort_by(|a, b| parse_ver(a).ok().cmp(&parse_ver(b).ok()));
            e.current = s.version.clone();
            e.enabled = true;
            e.permissions = s.permissions.clone();
            e.sha256 = s.sha256.clone();
            e.installed_at = crate::util::now_secs();
        }
        Ok(())
    })
}

/// Remove a plugin (all its versions). Refused while another enabled plugin depends on it.
pub fn remove(core: &Core, software: &str, id: &str, index: Option<&Index>) -> anyhow::Result<String> {
    modify_db(core, |db| {
        let m = db.software.get_mut(software).ok_or_else(|| anyhow!("{software} 沒有已安裝的外掛"))?;
        let key = m.keys().find(|k| k.eq_ignore_ascii_case(id)).cloned().ok_or_else(|| anyhow!("{software} 沒有安裝外掛 {id}"))?;
        if let Some(ix) = index {
            for p in m.values().filter(|p| p.enabled && !p.id.eq_ignore_ascii_case(id)) {
                let deps = ix.plugins.iter().find(|e| e.id == p.id).and_then(|e| e.versions.iter().find(|v| v.version == p.current)).map(|v| v.dependencies.clone()).unwrap_or_default();
                if deps.keys().any(|d| d.eq_ignore_ascii_case(id)) {
                    bail!("{} 相依於 {id}；請先移除或停用 {}", p.id, p.id);
                }
            }
        }
        let _ = std::fs::remove_dir_all(plugin_root(core, software).join(&key));
        m.remove(&key);
        Ok(key)
    })
}

pub fn set_enabled(core: &Core, software: &str, id: &str, enabled: bool) -> anyhow::Result<()> {
    modify_db(core, |db| {
        let m = db.software.get_mut(software).ok_or_else(|| anyhow!("{software} 沒有已安裝的外掛"))?;
        let p = m.values_mut().find(|p| p.id.eq_ignore_ascii_case(id)).ok_or_else(|| anyhow!("{software} 沒有安裝外掛 {id}"))?;
        p.enabled = enabled;
        Ok(())
    })
}

/// Switch to the previous installed version still on disk.
pub fn rollback(core: &Core, software: &str, id: &str, index: Option<&Index>) -> anyhow::Result<String> {
    modify_db(core, |db| {
        let root = plugin_root(core, software);
        let snapshot = db.software.get(software).cloned().unwrap_or_default();
        let m = db.software.get_mut(software).ok_or_else(|| anyhow!("{software} 沒有已安裝的外掛"))?;
        let p = m.values_mut().find(|p| p.id.eq_ignore_ascii_case(id)).ok_or_else(|| anyhow!("{software} 沒有安裝外掛 {id}"))?;
        let cur = parse_ver(&p.current)?;
        let prev = p
            .versions
            .iter()
            .filter(|v| parse_ver(v).map(|x| x < cur).unwrap_or(false) && root.join(&p.id).join(v).is_dir())
            .max_by(|a, b| parse_ver(a).ok().cmp(&parse_ver(b).ok()))
            .cloned()
            .ok_or_else(|| anyhow!("{} 沒有可回復的舊版本", p.id))?;
        if let Some(why) = index.and_then(|ix| broken_dependent(ix, &snapshot, &p.id, &prev)) {
            bail!("{why}；不會回復到 {prev}");
        }
        p.current = prev.clone();
        Ok(prev)
    })
}

/// Which software publishes a plugin with this id? (Used when no `-m <software>` is given.)
pub async fn owners(core: &Core, id: &str) -> Vec<(String, Index)> {
    let mut v = vec![];
    for p in core.catalog.iter().filter(|p| p.plugin_index.is_some()) {
        if let Ok(Some(ix)) = fetch_index(core, p).await {
            if ix.plugins.iter().any(|e| e.id.eq_ignore_ascii_case(id)) {
                v.push((p.id.clone(), ix));
            }
        }
    }
    v
}

pub fn host_version(core: &Core, software: &str) -> Option<semver::Version> {
    software_version(core, software)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(ver: &str, req: Option<&str>, deps: &[(&str, &str)], conflicts: &[&str]) -> PluginVersion {
        PluginVersion {
            version: ver.into(),
            url: "https://github.com/x/y/releases/download/v1/p.zip".into(),
            sha256: "a".repeat(64),
            size: 1,
            requires: req.map(String::from),
            dependencies: deps.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(),
            conflicts: conflicts.iter().map(|s| s.to_string()).collect(),
            permissions: vec!["files:plugin".into()],
            scripts: vec![],
        }
    }

    fn index() -> Index {
        Index {
            schema: 1,
            software: "runX".into(),
            plugins: vec![
                PluginEntry { id: "Core".into(), name: "Core".into(), description: String::new(), versions: vec![v("1.0.0", None, &[], &[]), v("1.2.0", None, &[], &[])] },
                PluginEntry { id: "Extra".into(), name: "Extra".into(), description: String::new(), versions: vec![v("2.0.0", Some(">=0.1.0-alpha"), &[("Core", "^1.1")], &[])] },
                PluginEntry { id: "Future".into(), name: "Future".into(), description: String::new(), versions: vec![v("1.0.0", Some(">=9.0.0"), &[], &[])] },
                PluginEntry { id: "Rival".into(), name: "Rival".into(), description: String::new(), versions: vec![v("1.0.0", None, &[], &["Core"])] },
                PluginEntry { id: "LoopA".into(), name: "A".into(), description: String::new(), versions: vec![v("1.0.0", None, &[("LoopB", "*")], &[])] },
                PluginEntry { id: "LoopB".into(), name: "B".into(), description: String::new(), versions: vec![v("1.0.0", None, &[("LoopA", "*")], &[])] },
            ],
        }
    }

    #[test]
    fn dependencies_first_with_matching_versions() {
        let sw = semver::Version::parse("0.1.0-alpha").unwrap();
        let p = plan(&index(), &PluginDb::default(), Some(&sw), "extra", None).unwrap();
        assert_eq!(p.iter().map(|s| (s.id.as_str(), s.version.as_str())).collect::<Vec<_>>(), vec![("Core", "1.2.0"), ("Extra", "2.0.0")]);
    }

    #[test]
    fn exact_version_and_incompatible_software() {
        let sw = semver::Version::parse("0.1.0-alpha").unwrap();
        assert_eq!(plan(&index(), &PluginDb::default(), Some(&sw), "Core", Some("1.0.0")).unwrap()[0].version, "1.0.0");
        assert!(plan(&index(), &PluginDb::default(), Some(&sw), "Future", None).unwrap_err().to_string().contains("相容"));
        assert!(plan(&index(), &PluginDb::default(), None, "Extra", None).is_err(), "requires the software installed");
    }

    #[test]
    fn dependents_are_not_broken_by_a_downgrade() {
        let mut db = PluginDb::default();
        let m = db.software.entry("runX".into()).or_default();
        m.insert("Core".into(), InstalledPlugin { id: "Core".into(), current: "1.2.0".into(), versions: vec!["1.2.0".into()], enabled: true, permissions: vec![], sha256: String::new(), installed_at: 0 });
        m.insert("Extra".into(), InstalledPlugin { id: "Extra".into(), current: "2.0.0".into(), versions: vec!["2.0.0".into()], enabled: true, permissions: vec![], sha256: String::new(), installed_at: 0 });
        let e = plan(&index(), &db, None, "Core", Some("1.0.0")).unwrap_err().to_string();
        assert!(e.contains("Extra") && e.contains("^1.1"), "{e}");
        // disabled dependents don't block
        db.software.get_mut("runX").unwrap().get_mut("Extra").unwrap().enabled = false;
        assert!(plan(&index(), &db, None, "Core", Some("1.0.0")).is_ok());
    }

    #[test]
    fn conflicts_and_cycles_are_refused() {
        let mut db = PluginDb::default();
        db.software.entry("runX".into()).or_default().insert("Core".into(), InstalledPlugin { id: "Core".into(), current: "1.2.0".into(), versions: vec!["1.2.0".into()], enabled: true, permissions: vec![], sha256: String::new(), installed_at: 0 });
        assert!(plan(&index(), &db, None, "Rival", None).unwrap_err().to_string().contains("衝突"));
        assert!(plan(&index(), &PluginDb::default(), None, "LoopA", None).unwrap_err().to_string().contains("循環"));
    }

    #[test]
    fn malicious_indexes_are_rejected() {
        let mut ix = index();
        ix.plugins[0].id = "../../evil".into();
        assert!(validate(&ix, "runX").is_err(), "path traversal in id");
        let mut ix = index();
        ix.plugins[0].versions[0].url = "http://evil.example/p.zip".into();
        assert!(validate(&ix, "runX").is_err(), "non-https / non-allow-listed url");
        let mut ix = index();
        ix.plugins[0].versions[0].permissions = vec!["admin".into()];
        assert!(validate(&ix, "runX").is_err(), "unknown permission");
        assert!(validate(&index(), "PikaraScienceStudio").is_err(), "index for another software");
        let mut ix = index();
        ix.plugins.push(ix.plugins[0].clone());
        assert!(validate(&ix, "runX").is_err(), "duplicate plugin id");
        assert!(serde_json::from_str::<Index>(r#"{"schema":1,"software":"runX","plugins":[],"postInstall":"rm -rf /"}"#).is_err(), "unknown fields");
    }
}
