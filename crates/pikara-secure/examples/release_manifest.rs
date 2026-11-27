//! Release tool (used by CI): builds `update.json` + `SHA256SUMS.txt` from a directory of
//! downloaded release assets. It refuses to produce anything unless every platform package is
//! present and its `.sig` verifies against the compiled-in Pikara release key.
//!
//! cargo run -p pikara-secure --example release_manifest -- \
//!     <assets-dir> <version> <owner/repo> <notes-file> <out-dir>

use pikara_secure::artifact::{sha256_file, verify_file};
use pikara_secure::keys::PIKARA_RELEASE_PUBKEY;
use pikara_secure::manifest::{Manifest, PlatformEntry};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Tauri platform key → required package file name suffix.
const PLATFORMS: &[(&str, &str)] = &[
    ("windows-x86_64", "_windows-x64-setup.exe"),
    ("darwin-aarch64", "_macos-arm64.app.tar.gz"),
    ("darwin-x86_64", "_macos-x64.app.tar.gz"),
];

fn utc_now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 6 {
        eprintln!("usage: release_manifest <assets-dir> <version> <owner/repo> <notes-file> <out-dir>");
        std::process::exit(2);
    }
    let (dir, version, repo, notes, out) = (Path::new(&a[1]), a[2].trim_start_matches('v'), &a[3], &a[4], Path::new(&a[5]));
    semver::Version::parse(version).expect("version must be SemVer");
    let notes = std::fs::read_to_string(notes).unwrap_or_default();

    let mut files: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_file()).collect();
    files.sort();

    // SHA256SUMS.txt over every published file (signatures included).
    let mut sums = String::new();
    for f in &files {
        let name = f.file_name().unwrap().to_string_lossy();
        if name == "SHA256SUMS.txt" {
            continue;
        }
        sums.push_str(&format!("{}  {}\n", sha256_file(f).unwrap(), name));
    }

    let mut platforms = BTreeMap::new();
    for (key, suffix) in PLATFORMS {
        let pkg = files
            .iter()
            .find(|p| p.file_name().unwrap().to_string_lossy().ends_with(suffix))
            .unwrap_or_else(|| panic!("missing package for {key} (*{suffix}); refusing to publish update.json"));
        let name = pkg.file_name().unwrap().to_string_lossy().to_string();
        let sig = std::fs::read_to_string(pkg.with_file_name(format!("{name}.sig"))).unwrap_or_else(|_| panic!("missing {name}.sig"));
        let sha = sha256_file(pkg).unwrap();
        // Fail closed: the package must verify with the key that clients will use.
        verify_file(pkg, &sha, &sig, PIKARA_RELEASE_PUBKEY).unwrap_or_else(|e| panic!("{name}: {e}"));
        let size = std::fs::metadata(pkg).unwrap().len();
        let url = format!("https://github.com/{repo}/releases/download/v{version}/{name}");
        println!("{key}: {name} {size} bytes sha256={sha} signature OK");
        platforms.insert(key.to_string(), PlatformEntry { url, signature: sig.trim().to_string(), sha256: sha, size });
    }

    let m = Manifest { product: "create-your-world".into(), version: version.into(), notes, pub_date: utc_now(), platforms };
    std::fs::create_dir_all(out).unwrap();
    std::fs::write(out.join("update.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(out.join("SHA256SUMS.txt"), sums).unwrap();
    println!("wrote update.json and SHA256SUMS.txt to {}", out.display());
}
