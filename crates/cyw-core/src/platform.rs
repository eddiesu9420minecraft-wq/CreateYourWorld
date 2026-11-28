//! OS / CPU detection and release-asset selection.

use crate::catalog::Product;
use crate::github::{GhAsset, GhRelease};
use crate::install::InstallKind;
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Platform {
    /// "windows" | "macos" | "linux"
    pub os: String,
    /// CPU of the machine (on Apple Silicon this is "aarch64" even under Rosetta).
    pub arch: String,
    /// Architecture this CYW binary was compiled for.
    pub build_arch: String,
    pub rosetta: bool,
}

impl Platform {
    pub fn detect() -> Self {
        let os = std::env::consts::OS.to_string();
        let build_arch = std::env::consts::ARCH.to_string();
        let rosetta = os == "macos" && build_arch == "x86_64" && is_translated();
        let arch = if rosetta { "aarch64".to_string() } else { build_arch.clone() };
        Self { os, arch, build_arch, rosetta }
    }
    pub fn key(&self) -> String {
        format!("{}-{}", self.os, self.arch)
    }
}

#[cfg(target_os = "macos")]
fn is_translated() -> bool {
    crate::util::hidden_command("sysctl")
        .args(["-in", "sysctl.proc_translated"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
        .unwrap_or(false)
}
#[cfg(not(target_os = "macos"))]
fn is_translated() -> bool {
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedAsset {
    pub name: String,
    pub size: u64,
    pub url: String,
    pub digest: Option<String>,
    pub kind: InstallKind,
    pub launch: Option<String>,
}

fn selected(a: &GhAsset, kind: InstallKind, launch: Option<String>) -> SelectedAsset {
    SelectedAsset { name: a.name.clone(), size: a.size, url: a.browser_download_url.clone(), digest: a.digest.clone(), kind, launch }
}

/// Pick the right asset for this machine: catalog rules first, then generic heuristics.
pub fn select_asset(product: &Product, release: &GhRelease, plat: &Platform) -> Option<SelectedAsset> {
    let ignore: Vec<Regex> = product.ignore_assets.iter().filter_map(|p| Regex::new(p).ok()).collect();
    let candidates: Vec<&GhAsset> = release
        .assets
        .iter()
        .filter(|a| !ignore.iter().any(|r| r.is_match(&a.name)))
        .collect();

    // Catalog rules. Under Rosetta also accept x86_64 rules as a fallback.
    let mut keys = vec![plat.key()];
    if plat.rosetta {
        keys.push(format!("{}-x86_64", plat.os));
    }
    for key in &keys {
        if let Some(rules) = product.assets.get(key) {
            for rule in rules {
                let Ok(re) = Regex::new(&rule.pattern) else { continue };
                if let Some(a) = candidates.iter().find(|a| re.is_match(&a.name)) {
                    return Some(selected(a, rule.kind, rule.launch.clone()));
                }
            }
        }
    }

    // Heuristics for products without explicit rules.
    candidates
        .iter()
        .filter_map(|a| heuristic(&a.name, plat).map(|(score, kind)| (score, kind, *a)))
        .max_by_key(|(score, _, _)| *score)
        .map(|(_, kind, a)| selected(a, kind, None))
}

fn heuristic(name: &str, plat: &Platform) -> Option<(i32, InstallKind)> {
    let n = name.to_ascii_lowercase();
    if [".sig", ".sha256", ".txt", ".json", ".blockmap", ".asc", ".minisig"].iter().any(|s| n.ends_with(s)) {
        return None;
    }
    let (os, kind, kind_score) = if n.ends_with(".dmg") {
        ("macos", InstallKind::Dmg, 30)
    } else if n.ends_with(".app.tar.gz") {
        ("macos", InstallKind::AppTar, 40)
    } else if n.ends_with(".appimage") {
        ("linux", InstallKind::AppImage, 40)
    } else if n.ends_with("-setup.exe") || n.ends_with("_setup.exe") || n.contains("installer") && n.ends_with(".exe") {
        ("windows", InstallKind::Nsis, 20)
    } else if n.ends_with(".exe") {
        ("windows", InstallKind::Portable, 40)
    } else if n.ends_with(".zip") || n.ends_with(".tar.gz") || n.ends_with(".tgz") {
        let os = if has_any(&n, &["windows", "win64", "win32", "-win", "_win"]) {
            "windows"
        } else if has_any(&n, &["macos", "darwin", "osx", "-mac", "_mac"]) {
            "macos"
        } else if n.contains("linux") {
            "linux"
        } else {
            return None;
        };
        (os, InstallKind::Archive, 10)
    } else {
        return None;
    };
    if os != plat.os {
        return None;
    }

    let mentions_x64 = has_any(&n, &["x64", "x86_64", "amd64", "win64"]);
    let mentions_arm = has_any(&n, &["arm64", "aarch64"]);
    let universal = n.contains("universal");
    let arch_score = match plat.arch.as_str() {
        "x86_64" if mentions_x64 => 20,
        "aarch64" if mentions_arm => 20,
        _ if universal => 15,
        "x86_64" if mentions_arm => return None,
        "aarch64" if mentions_x64 => {
            // x86_64 macOS builds still run under Rosetta; Windows-on-ARM emulates x64 too.
            if plat.os == "linux" { return None } else { 1 }
        }
        _ => 5,
    };
    Some((kind_score + arch_score, kind))
}

fn has_any(n: &str, needles: &[&str]) -> bool {
    needles.iter().any(|x| n.contains(x))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> GhAsset {
        GhAsset { name: name.into(), size: 1, browser_download_url: format!("https://x/{name}"), digest: None }
    }
    fn release(names: &[&str]) -> GhRelease {
        GhRelease { tag_name: "v1.0.0".into(), name: None, prerelease: false, draft: false, published_at: None, html_url: String::new(), body: None, assets: names.iter().map(|n| asset(n)).collect() }
    }
    fn plat(os: &str, arch: &str) -> Platform {
        Platform { os: os.into(), arch: arch.into(), build_arch: arch.into(), rosetta: false }
    }

    #[test]
    fn studio_rules() {
        let catalog = crate::catalog::load();
        let studio = catalog.iter().find(|p| p.id == "PikaraScienceStudio").unwrap();
        let r = release(&["pikara-studio-skill.zip", "Pikara.Science.Studio_0.3.1_x64-setup.exe", "PikaraScienceStudio.exe", "SHA256SUMS.txt"]);
        let a = select_asset(studio, &r, &plat("windows", "x86_64")).unwrap();
        assert_eq!(a.name, "PikaraScienceStudio.exe");
        assert_eq!(a.kind, InstallKind::Portable);
        // Windows-only release: nothing for macOS.
        assert!(select_asset(studio, &r, &plat("macos", "aarch64")).is_none());
        assert!(select_asset(studio, &r, &plat("macos", "x86_64")).is_none());
    }

    #[test]
    fn heuristics_pick_arch() {
        let p = crate::catalog::Product {
            id: "x".into(), legacy_ids: vec![], name: "x".into(), tagline: String::new(), description: String::new(), repo: None, glyph: None,
            assets: Default::default(), ignore_assets: vec![], minisign_public_key: None,
            category: Default::default(), cli: None, default_channel: None, plugin_index: None,
        };
        let r = release(&["App_1.0.0_aarch64.dmg", "App_1.0.0_x64.dmg", "App_1.0.0_x64-setup.exe", "App_1.0.0_amd64.AppImage", "App_x64.app.tar.gz.sig"]);
        assert_eq!(select_asset(&p, &r, &plat("macos", "aarch64")).unwrap().name, "App_1.0.0_aarch64.dmg");
        assert_eq!(select_asset(&p, &r, &plat("macos", "x86_64")).unwrap().name, "App_1.0.0_x64.dmg");
        assert_eq!(select_asset(&p, &r, &plat("windows", "x86_64")).unwrap().kind, InstallKind::Nsis);
        assert_eq!(select_asset(&p, &r, &plat("linux", "x86_64")).unwrap().kind, InstallKind::AppImage);
        assert!(select_asset(&p, &r, &plat("linux", "aarch64")).is_none());
    }
}
