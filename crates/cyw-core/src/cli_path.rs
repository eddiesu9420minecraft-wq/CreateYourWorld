//! Command-line tools on the user's PATH (developer tools such as runX's `runxc`).
//!
//! Every installed version lives in its own folder, so PATH can't point at a version directly. CYW keeps one
//! stable folder, `<data>/bin`, holds a copy of the *current* version's binary for each tool the user put on
//! PATH, and registers that folder in the user's PATH (Windows: `HKCU\Environment\Path`; nothing system-wide,
//! no administrator rights). `sync` runs after every change to installed.json — install, update, switch,
//! rollback, uninstall — so the copy always matches the current version, and the PATH entry is removed again
//! when no tool needs it.
//!
//! Tests set `PIKARA_CYW_ENV_KEY` (a registry key under HKCU) so they never touch the real user PATH.

use crate::catalog::Product;
use crate::install::InstalledDb;
use crate::paths::Paths;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub fn bin_dir(paths: &Paths) -> PathBuf {
    paths.data.join("bin")
}

/// File name of a product's command-line binary on this platform (`runxc.exe` on Windows).
pub fn binary_name(p: &Product) -> Option<String> {
    p.cli.as_ref().map(|c| format!("{}{}", c.binary, std::env::consts::EXE_SUFFIX))
}

fn sha256(p: &Path) -> Option<String> {
    let bytes = std::fs::read(p).ok()?;
    Some(Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect())
}

/// Replace `target` with a copy of `src`. A running copy of the old binary can't be deleted on Windows but can
/// be renamed, so the old file is moved aside first and removed on a later sync.
fn copy_replace(src: &Path, target: &Path) -> std::io::Result<()> {
    let dir = target.parent().unwrap();
    std::fs::create_dir_all(dir)?;
    let tmp = target.with_extension("cyw-new");
    std::fs::copy(src, &tmp)?;
    if target.exists() && std::fs::remove_file(target).is_err() {
        let aside = dir.join(format!(".{}.old-{}", target.file_name().unwrap().to_string_lossy(), std::process::id()));
        std::fs::rename(target, aside)?;
    }
    std::fs::rename(&tmp, target)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

fn remove_stale(dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with('.') && n.contains(".old-") || n.ends_with(".cyw-new") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

/// Bring `<data>/bin` and the PATH registration in line with installed.json. Returns problems per product
/// (empty when everything is in place); never fails the caller.
pub fn sync(paths: &Paths, catalog: &[Product], db: &InstalledDb) -> Vec<(String, String)> {
    let bin = bin_dir(paths);
    remove_stale(&bin);
    let mut problems = vec![];
    let mut wanted = 0;
    for p in catalog {
        let Some(name) = binary_name(p) else { continue };
        let target = bin.join(&name);
        let current = db.apps.get(&p.id).filter(|a| a.on_path).and_then(|a| a.current_version().cloned());
        match current {
            Some(v) => {
                wanted += 1;
                if !v.launch.is_file() {
                    problems.push((p.id.clone(), format!("找不到 {}", v.launch.display())));
                    continue;
                }
                if sha256(&v.launch) != sha256(&target) {
                    if let Err(e) = copy_replace(&v.launch, &target) {
                        problems.push((p.id.clone(), format!("無法更新 {}：{e}", target.display())));
                    }
                }
            }
            None => {
                if target.exists() && std::fs::remove_file(&target).is_err() {
                    let aside = bin.join(format!(".{name}.old-{}", std::process::id()));
                    let _ = std::fs::rename(&target, aside);
                }
            }
        }
    }
    let r = if wanted > 0 { user_path::add(&bin) } else { user_path::remove(&bin) };
    if let Err(e) = r {
        problems.push((String::new(), format!("無法更新使用者 PATH：{e}")));
    }
    problems
}

/// Is `<data>/bin` registered in the user PATH?
pub fn registered(paths: &Paths) -> bool {
    user_path::contains(&bin_dir(paths)).unwrap_or(false)
}

fn same_dir(a: &str, b: &Path) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches(['\\', '/']).to_lowercase();
    norm(a) == norm(&b.to_string_lossy())
}

#[cfg(windows)]
mod user_path {
    use super::same_dir;
    use std::path::Path;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_EXPAND_SZ};
    use winreg::{RegKey, RegValue};

    fn key_path() -> String {
        std::env::var("PIKARA_CYW_ENV_KEY").ok().filter(|k| !k.is_empty()).unwrap_or_else(|| "Environment".into())
    }

    fn read() -> std::io::Result<(RegKey, Vec<String>)> {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey_with_flags(key_path(), KEY_READ | KEY_WRITE)?;
        let cur: String = key.get_value("Path").unwrap_or_default();
        Ok((key, cur.split(';').filter(|s| !s.trim().is_empty()).map(String::from).collect()))
    }

    fn write(key: &RegKey, parts: &[String]) -> std::io::Result<()> {
        let s = parts.join(";");
        let mut bytes: Vec<u8> = s.encode_utf16().chain(std::iter::once(0)).flat_map(|c| c.to_le_bytes()).collect();
        if bytes.is_empty() {
            bytes = vec![0, 0];
        }
        // REG_EXPAND_SZ keeps %USERPROFILE%-style entries working
        key.set_raw_value("Path", &RegValue { bytes: bytes.into(), vtype: REG_EXPAND_SZ })?;
        broadcast();
        Ok(())
    }

    /// Tell Explorer and new terminals that the environment changed.
    fn broadcast() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};
        let env: Vec<u16> = "Environment\0".encode_utf16().collect();
        let mut result = 0usize;
        unsafe {
            SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, env.as_ptr() as isize, SMTO_ABORTIFHUNG, 3000, &mut result);
        }
    }

    pub fn contains(dir: &Path) -> std::io::Result<bool> {
        Ok(read()?.1.iter().any(|p| same_dir(p, dir)))
    }

    pub fn add(dir: &Path) -> std::io::Result<()> {
        let (key, mut parts) = read()?;
        if parts.iter().any(|p| same_dir(p, dir)) {
            return Ok(());
        }
        parts.push(dir.to_string_lossy().to_string());
        write(&key, &parts)
    }

    pub fn remove(dir: &Path) -> std::io::Result<()> {
        let (key, parts) = read()?;
        let kept: Vec<String> = parts.iter().filter(|p| !same_dir(p, dir)).cloned().collect();
        if kept.len() == parts.len() {
            return Ok(());
        }
        write(&key, &kept)
    }
}

/// macOS / Linux: a symlink in `~/.local/bin` (on PATH by default on most Linux distributions; on macOS the
/// user may need to add it). Untested on real hardware.
#[cfg(not(windows))]
mod user_path {
    use std::path::{Path, PathBuf};

    fn local_bin() -> Option<PathBuf> {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("bin"))
    }

    fn links(dir: &Path) -> Vec<(PathBuf, PathBuf)> {
        let Some(lb) = local_bin() else { return vec![] };
        std::fs::read_dir(dir)
            .map(|rd| rd.flatten().filter(|e| !e.file_name().to_string_lossy().starts_with('.')).map(|e| (lb.join(e.file_name()), e.path())).collect())
            .unwrap_or_default()
    }

    pub fn contains(dir: &Path) -> std::io::Result<bool> {
        Ok(links(dir).iter().any(|(l, t)| std::fs::read_link(l).is_ok_and(|x| &x == t)))
    }

    pub fn add(dir: &Path) -> std::io::Result<()> {
        let lb = local_bin().ok_or_else(|| std::io::Error::other("HOME is not set"))?;
        std::fs::create_dir_all(&lb)?;
        for (l, t) in links(dir) {
            if std::fs::read_link(&l).is_ok_and(|x| x == t) {
                continue;
            }
            if l.exists() {
                return Err(std::io::Error::other(format!("{} already exists and was not created by Create Your World", l.display())));
            }
            std::os::unix::fs::symlink(&t, &l)?;
        }
        Ok(())
    }

    pub fn remove(dir: &Path) -> std::io::Result<()> {
        let Some(lb) = local_bin() else { return Ok(()) };
        if let Ok(rd) = std::fs::read_dir(&lb) {
            for e in rd.flatten() {
                if std::fs::read_link(e.path()).is_ok_and(|t| t.starts_with(dir)) {
                    std::fs::remove_file(e.path())?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::{InstallKind, InstalledApp, InstalledVersion};
    use crate::verify::VerifyReport;

    fn product() -> Product {
        serde_json::from_value(serde_json::json!({
            "id": "tool", "name": "Tool", "tagline": "", "description": "", "category": "devtool",
            "cli": { "binary": "tooltest" }
        }))
        .unwrap()
    }

    #[test]
    fn same_dir_ignores_case_and_trailing_slash() {
        assert!(same_dir(r"C:\Users\A\bin\", Path::new(r"c:\users\a\bin")));
        assert!(!same_dir(r"C:\Users\A\bin2", Path::new(r"C:\Users\A\bin")));
    }

    /// Full cycle against a throwaway registry key (never the real PATH): put on PATH, update the version,
    /// take off PATH.
    #[test]
    #[cfg(windows)]
    fn sync_cycle_uses_a_test_registry_key() {
        let key = format!(r"Software\PikaraCYWTest\Env-{}", std::process::id());
        // SAFETY: tests in this module are the only users of PIKARA_CYW_ENV_KEY
        unsafe { std::env::set_var("PIKARA_CYW_ENV_KEY", &key) };
        let root = std::env::temp_dir().join(format!("cyw-clipath-{}", std::process::id()));
        let paths = Paths::for_test(&root);
        let p = product();
        let mk = |tag: &str, body: &[u8]| {
            let dir = root.join("apps").join("tool").join(tag);
            std::fs::create_dir_all(&dir).unwrap();
            let exe = dir.join(binary_name(&p).unwrap());
            std::fs::write(&exe, body).unwrap();
            InstalledVersion { tag: tag.into(), dir, launch: exe, kind: InstallKind::Archive, asset_name: "t.zip".into(), size: 1, verification: VerifyReport::default(), installed_at: 0 }
        };
        let mut db = InstalledDb::default();
        db.apps.insert("tool".into(), InstalledApp { product_id: "tool".into(), current: "v1".into(), versions: vec![mk("v1", b"one")], on_path: true });

        assert!(sync(&paths, std::slice::from_ref(&p), &db).is_empty());
        let target = bin_dir(&paths).join(binary_name(&p).unwrap());
        assert_eq!(std::fs::read(&target).unwrap(), b"one");
        assert!(registered(&paths));

        // update → the copy follows the current version
        let app = db.apps.get_mut("tool").unwrap();
        app.versions.push(mk("v2", b"two"));
        app.current = "v2".into();
        assert!(sync(&paths, std::slice::from_ref(&p), &db).is_empty());
        assert_eq!(std::fs::read(&target).unwrap(), b"two");

        // taken off PATH (or uninstalled) → copy and PATH entry removed
        db.apps.get_mut("tool").unwrap().on_path = false;
        assert!(sync(&paths, std::slice::from_ref(&p), &db).is_empty());
        assert!(!target.exists());
        assert!(!registered(&paths));

        let _ = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).delete_subkey_all(r"Software\PikaraCYWTest");
        let _ = std::fs::remove_dir_all(&root);
    }
}
