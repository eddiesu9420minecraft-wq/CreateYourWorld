//! Signed `update.json` (Tauri-updater compatible fields + `product`, `sha256`, `size`).
//!
//! ```json
//! { "product": "create-your-world", "version": "0.1.1-alpha", "notes": "…",
//!   "pub_date": "2026-11-27T10:00:00Z",
//!   "platforms": { "windows-x86_64": { "url": "https://github.com/…", "signature": "…",
//!                                      "sha256": "…", "size": 123 } } }
//! ```
//! `update.json.sig` is a minisign signature over the exact bytes of `update.json`, made with
//! the Pikara release key. Nothing in the JSON can change which key is trusted.

use crate::{keys, net, SecureError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformEntry {
    pub url: String,
    /// Minisign signature of the artifact (Tauri `.sig` content).
    pub signature: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub product: String,
    pub version: String,
    #[serde(default)]
    pub notes: String,
    pub pub_date: String,
    pub platforms: BTreeMap<String, PlatformEntry>,
}

/// Persisted between runs so an attacker can't replay an older (validly signed) manifest.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReplayState {
    pub highest_version: Option<String>,
    pub last_pub_date: Option<String>,
}

pub struct Policy<'a> {
    pub product: &'a str,
    pub pubkey: &'a str,
    pub current_version: &'a str,
    /// e.g. `https://github.com/<owner>/<repo>/releases/download/` — the artifact must live
    /// under `<prefix>v<version>/`, binding it to the signed version's release tag.
    pub release_prefix: &'a str,
    /// Tauri platform key, e.g. `windows-x86_64`, `darwin-aarch64`.
    pub platform_key: &'a str,
}

#[derive(Debug, Clone)]
pub enum Verdict {
    UpToDate { latest: String },
    Update { manifest: Manifest, entry: PlatformEntry },
}

fn parse_ver(v: &str) -> Result<semver::Version, SecureError> {
    semver::Version::parse(v.trim_start_matches('v')).map_err(|e| SecureError::Manifest(format!("版本號 {v} 不是合法的 SemVer：{e}")))
}

/// Only the canonical `YYYY-MM-DDTHH:MM:SSZ` form, so lexical order == time order.
fn check_date(d: &str) -> Result<(), SecureError> {
    let b = d.as_bytes();
    let ok = b.len() == 20
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            19 => *c == b'Z',
            _ => c.is_ascii_digit(),
        });
    if ok { Ok(()) } else { Err(SecureError::Manifest(format!("pub_date 格式錯誤：{d}"))) }
}

/// Verify signature, identity, freshness and URL binding. Returns the verdict and the replay
/// state the caller must persist when it accepts the verdict.
pub fn verify(json: &[u8], sig: &str, policy: &Policy, state: &ReplayState) -> Result<(Verdict, ReplayState), SecureError> {
    // 1. Authenticity first: nothing in an unsigned/forged document is even parsed.
    keys::verify_bytes(policy.pubkey, sig, json)?;
    let m: Manifest = serde_json::from_slice(json).map_err(|e| SecureError::Manifest(e.to_string()))?;

    // 2. Identity: a valid manifest of another Pikara product must not be accepted.
    if m.product != policy.product {
        return Err(SecureError::Manifest(format!("產品不符：{}", m.product)));
    }
    check_date(&m.pub_date)?;
    let offered = parse_ver(&m.version)?;
    let current = parse_ver(policy.current_version)?;

    // 3. Freshness: never go backwards.
    if offered < current {
        return Err(SecureError::Downgrade { offered: m.version.clone(), current: policy.current_version.into() });
    }
    if let Some(h) = &state.highest_version {
        if offered < parse_ver(h)? {
            return Err(SecureError::Replay(format!("已見過較新的版本 {h}，此檔案為 {}", m.version)));
        }
    }
    if let Some(last) = &state.last_pub_date {
        if m.pub_date.as_str() < last.as_str() {
            return Err(SecureError::Replay(format!("發布時間 {} 早於已接受的 {last}", m.pub_date)));
        }
    }
    let new_state = ReplayState { highest_version: Some(m.version.clone()), last_pub_date: Some(m.pub_date.clone()) };

    if offered == current {
        return Ok((Verdict::UpToDate { latest: m.version.clone() }, new_state));
    }

    // 4. The artifact must be an https URL on GitHub, inside this exact version's release.
    let entry = m
        .platforms
        .get(policy.platform_key)
        .cloned()
        .ok_or_else(|| SecureError::Manifest(format!("{} 沒有 {} 的更新包", m.version, policy.platform_key)))?;
    net::check_url(&entry.url, net::GITHUB_HOSTS)?;
    let want_prefix = format!("{}v{}/", policy.release_prefix, m.version.trim_start_matches('v'));
    if !entry.url.starts_with(&want_prefix) {
        return Err(SecureError::UrlRejected(format!("更新包網址不屬於 v{} 的發布：{}", m.version, entry.url)));
    }
    if entry.sha256.len() != 64 || !entry.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(SecureError::Manifest("sha256 欄位格式錯誤".into()));
    }
    if entry.signature.trim().is_empty() || entry.size == 0 {
        return Err(SecureError::Manifest("缺少簽章或檔案大小".into()));
    }
    Ok((Verdict::Update { manifest: m, entry }, new_state))
}

pub fn platform_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("windows-x86_64"),
        ("macos", "aarch64") => Some("darwin-aarch64"),
        ("macos", "x86_64") => Some("darwin-x86_64"),
        ("linux", "x86_64") => Some("linux-x86_64"),
        _ => None,
    }
}
