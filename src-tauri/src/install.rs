//! Installing, launching and removing app versions.
//!
//! Layout: `<apps>/<product-id>/<tag>/…`. Each version lives in its own directory, so an
//! update never touches the version currently in use. Work happens in a staging directory
//! that is only renamed into place once everything succeeded; any failure deletes the
//! staging directory and leaves the previous install exactly as it was.

use crate::archive;
use crate::platform::SelectedAsset;
use crate::util::{now_secs, sanitize_component};
use crate::verify::VerifyReport;
use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallKind {
    /// A single executable that runs in place (Windows `.exe`).
    Portable,
    /// NSIS installer, run silently into the CYW-managed directory.
    Nsis,
    /// macOS disk image containing an `.app` bundle.
    Dmg,
    /// macOS `.app.tar.gz` (Tauri updater bundle).
    AppTar,
    /// Linux AppImage.
    AppImage,
    /// Generic `.zip` / `.tar.gz`.
    Archive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledVersion {
    pub tag: String,
    pub dir: PathBuf,
    pub launch: PathBuf,
    pub kind: InstallKind,
    pub asset_name: String,
    pub size: u64,
    pub verification: VerifyReport,
    pub installed_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub product_id: String,
    pub current: String,
    /// Newest first.
    pub versions: Vec<InstalledVersion>,
    /// Command-line tool: the user asked CYW to keep its binary on PATH (see `cli_path`).
    #[serde(default)]
    pub on_path: bool,
}

impl InstalledApp {
    pub fn current_version(&self) -> Option<&InstalledVersion> {
        self.versions.iter().find(|v| v.tag == self.current)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InstalledDb {
    #[serde(default)]
    pub apps: BTreeMap<String, InstalledApp>,
}

pub fn product_dir(apps_root: &Path, product_id: &str) -> PathBuf {
    apps_root.join(sanitize_component(product_id))
}

/// Install `file` (already downloaded and verified) as version `tag` of `product_id`.
pub fn install(apps_root: &Path, product_id: &str, tag: &str, asset: &SelectedAsset, file: &Path) -> anyhow::Result<(PathBuf, PathBuf)> {
    let pdir = product_dir(apps_root, product_id);
    fs::create_dir_all(&pdir)?;
    let final_dir = pdir.join(sanitize_component(tag));

    if asset.kind == InstallKind::Nsis {
        return install_nsis(&final_dir, asset, file);
    }

    let staging = pdir.join(format!(".staging-{}-{}", sanitize_component(tag), now_secs()));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;
    let result = (|| -> anyhow::Result<PathBuf> {
        let rel_launch = populate(&staging, asset, file)?;
        commit_dir(&staging, &final_dir)?;
        Ok(final_dir.join(rel_launch))
    })();
    match result {
        Ok(launch) => Ok((final_dir, launch)),
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            Err(e)
        }
    }
}

/// Fill `staging` and return the launch target relative to it.
fn populate(staging: &Path, asset: &SelectedAsset, file: &Path) -> anyhow::Result<PathBuf> {
    let file_name = sanitize_component(&asset.name);
    match asset.kind {
        InstallKind::Portable | InstallKind::AppImage => {
            let dst = staging.join(&file_name);
            fs::copy(file, &dst).context("複製程式檔失敗")?;
            make_executable(&dst)?;
            Ok(PathBuf::from(file_name))
        }
        InstallKind::AppTar => {
            archive::extract_tar_gz(file, staging)?;
            find_app_bundle(staging).map(|p| rel(staging, &p)).ok_or_else(|| anyhow!("封存檔中找不到 .app"))
        }
        InstallKind::Archive => {
            archive::extract_any(file, &asset.name, staging)?;
            let target = match &asset.launch {
                Some(name) => {
                    let direct = staging.join(name);
                    if direct.exists() { Some(direct) } else { find_named(staging, name, 5) }
                }
                None => find_executable(staging, 4),
            };
            let target = target.ok_or_else(|| anyhow!("封存檔中找不到可執行的程式"))?;
            make_executable(&target)?;
            Ok(rel(staging, &target))
        }
        InstallKind::Dmg => install_dmg(staging, file),
        InstallKind::Nsis => unreachable!(),
    }
}

fn rel(root: &Path, p: &Path) -> PathBuf {
    p.strip_prefix(root).map(Path::to_path_buf).unwrap_or_else(|_| p.to_path_buf())
}

/// Atomically move `staging` into `final_dir`, keeping the old content until the swap succeeded.
fn commit_dir(staging: &Path, final_dir: &Path) -> anyhow::Result<()> {
    if final_dir.exists() {
        let backup = final_dir.with_file_name(format!(
            ".replaced-{}-{}",
            final_dir.file_name().unwrap_or_default().to_string_lossy(),
            now_secs()
        ));
        fs::rename(final_dir, &backup).context("無法取代既有版本（程式可能仍在執行）")?;
        if let Err(e) = fs::rename(staging, final_dir) {
            let _ = fs::rename(&backup, final_dir);
            return Err(e).context("無法完成安裝");
        }
        let _ = fs::remove_dir_all(&backup);
    } else {
        fs::rename(staging, final_dir).context("無法完成安裝")?;
    }
    Ok(())
}

#[cfg(windows)]
fn install_nsis(final_dir: &Path, asset: &SelectedAsset, file: &Path) -> anyhow::Result<(PathBuf, PathBuf)> {
    use std::os::windows::process::CommandExt;
    if final_dir.exists() {
        bail!("此版本已安裝；請先解除安裝再重新安裝");
    }
    fs::create_dir_all(final_dir)?;
    // NSIS requires `/D=` to be last and unquoted, even when the path has spaces.
    let status = Command::new(file)
        .arg("/S")
        .raw_arg(format!("/D={}", final_dir.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("無法執行安裝程式")?;
    let found = asset
        .launch
        .as_ref()
        .and_then(|n| find_named(final_dir, n, 3))
        .or_else(|| find_executable(final_dir, 2));
    match (status.success(), found) {
        (true, Some(launch)) => Ok((final_dir.to_path_buf(), launch)),
        (ok, _) => {
            let _ = uninstall_dir(final_dir, InstallKind::Nsis);
            if ok {
                bail!("安裝程式完成，但找不到主程式")
            } else {
                bail!("安裝程式失敗（結束代碼 {:?}）", status.code())
            }
        }
    }
}

#[cfg(not(windows))]
fn install_nsis(_: &Path, _: &SelectedAsset, _: &Path) -> anyhow::Result<(PathBuf, PathBuf)> {
    bail!("NSIS 安裝程式只能在 Windows 上執行")
}

#[cfg(target_os = "macos")]
fn install_dmg(staging: &Path, file: &Path) -> anyhow::Result<PathBuf> {
    let mount = std::env::temp_dir().join(format!("cyw-dmg-{}", now_secs()));
    fs::create_dir_all(&mount)?;
    let out = crate::util::hidden_command("hdiutil")
        .args(["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint"])
        .arg(&mount)
        .arg(file)
        .output()
        .context("無法執行 hdiutil")?;
    if !out.status.success() {
        bail!("無法掛載 DMG：{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    let result = (|| -> anyhow::Result<PathBuf> {
        let app = fs::read_dir(&mount)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|x| x == "app"))
            .ok_or_else(|| anyhow!("DMG 中找不到 .app"))?;
        let name = app.file_name().unwrap().to_owned();
        let st = crate::util::hidden_command("ditto").arg(&app).arg(staging.join(&name)).status()?;
        if !st.success() {
            bail!("複製 .app 失敗");
        }
        Ok(PathBuf::from(name))
    })();
    let _ = crate::util::hidden_command("hdiutil").args(["detach", "-quiet"]).arg(&mount).status();
    let _ = fs::remove_dir(&mount);
    result
}

#[cfg(not(target_os = "macos"))]
fn install_dmg(_: &Path, _: &Path) -> anyhow::Result<PathBuf> {
    bail!("DMG 只能在 macOS 上安裝")
}

fn make_executable(_p: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if _p.is_file() {
            fs::set_permissions(_p, fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(())
}

fn find_app_bundle(root: &Path) -> Option<PathBuf> {
    walk(root, 2).into_iter().find(|p| p.is_dir() && p.extension().is_some_and(|x| x == "app"))
}

fn find_named(root: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    let base = Path::new(name).file_name()?.to_owned();
    walk(root, depth).into_iter().find(|p| p.file_name() == Some(base.as_os_str()))
}

fn find_executable(root: &Path, depth: usize) -> Option<PathBuf> {
    let items = walk(root, depth);
    if cfg!(windows) {
        items.into_iter().find(|p| {
            let n = p.file_name().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
            n.ends_with(".exe") && !n.starts_with("uninst") && !n.contains("setup")
        })
    } else if cfg!(target_os = "macos") {
        items.into_iter().find(|p| p.is_dir() && p.extension().is_some_and(|x| x == "app"))
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            return items.into_iter().find(|p| {
                p.is_file() && fs::metadata(p).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
            });
        }
        #[allow(unreachable_code)]
        None
    }
}

/// Breadth-first listing up to `depth` levels (does not descend into `.app` bundles).
fn walk(root: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut level = vec![root.to_path_buf()];
    for _ in 0..depth {
        let mut next = vec![];
        for dir in level {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            let mut entries: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
            entries.sort();
            for p in entries {
                if p.is_dir() && !p.extension().is_some_and(|x| x == "app") {
                    next.push(p.clone());
                }
                out.push(p);
            }
        }
        level = next;
    }
    out
}

/// Remove one installed version directory (running its uninstaller first for NSIS installs).
pub fn uninstall_dir(dir: &Path, kind: InstallKind) -> anyhow::Result<()> {
    #[cfg(windows)]
    if kind == InstallKind::Nsis {
        use std::os::windows::process::CommandExt;
        let un = dir.join("uninstall.exe");
        if un.exists() {
            // `_?=` makes the NSIS uninstaller run in place and wait until it finishes.
            let _ = Command::new(&un)
                .arg("/S")
                .raw_arg(format!("_?={}", dir.display()))
                .stdin(Stdio::null())
                .status();
        }
    }
    let _ = kind;
    if dir.exists() {
        fs::remove_dir_all(dir).with_context(|| format!("無法刪除 {}（程式可能仍在執行）", dir.display()))?;
    }
    Ok(())
}

pub fn launch(path: &Path) -> anyhow::Result<()> {
    if !path.exists() {
        bail!("找不到程式檔：{}", path.display());
    }
    #[cfg(target_os = "macos")]
    if path.extension().is_some_and(|x| x == "app") {
        Command::new("open").arg(path).spawn().context("無法啟動應用程式")?;
        return Ok(());
    }
    let mut cmd = Command::new(path);
    if let Some(dir) = path.parent() {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn().context("無法啟動應用程式")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_install_and_failed_update_keeps_old() {
        let root = std::env::temp_dir().join(format!("cyw-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let src = root.join("App.exe");
        fs::write(&src, b"v1").unwrap();
        let asset = SelectedAsset { name: "App.exe".into(), size: 2, url: String::new(), digest: None, kind: InstallKind::Portable, launch: None };
        let (dir, launch) = install(&root.join("apps"), "demo", "v1.0.0", &asset, &src).unwrap();
        assert_eq!(fs::read(&launch).unwrap(), b"v1");

        // A broken archive must fail and leave v1 untouched with no staging leftovers.
        let bad = root.join("bad.zip");
        fs::write(&bad, b"not a zip").unwrap();
        let bad_asset = SelectedAsset { name: "bad.zip".into(), kind: InstallKind::Archive, ..asset.clone() };
        assert!(install(&root.join("apps"), "demo", "v2.0.0", &bad_asset, &bad).is_err());
        assert!(launch.exists());
        let leftovers: Vec<_> = fs::read_dir(dir.parent().unwrap()).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(leftovers.len(), 1);
        let _ = fs::remove_dir_all(&root);
    }
}
