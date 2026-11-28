//! GitHub Releases API client with on-disk ETag cache and rate-limit handling.

use crate::util::{load_json, now_secs, save_json};
use anyhow::{anyhow, bail};
use reqwest::header::{HeaderMap, ACCEPT, ETAG, IF_NONE_MATCH};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Cached responses younger than this are served without touching the network.
const FRESH_SECS: u64 = 10 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhAsset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
    /// `sha256:<hex>` — computed by GitHub on upload (present for assets uploaded since mid-2025).
    #[serde(default)]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhRelease {
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    pub prerelease: bool,
    pub draft: bool,
    #[serde(default)]
    pub published_at: Option<String>,
    pub html_url: String,
    #[serde(default)]
    pub body: Option<String>,
    pub assets: Vec<GhAsset>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    Beta,
    Alpha,
}

impl Channel {
    fn rank(self) -> u8 {
        match self {
            Channel::Stable => 0,
            Channel::Beta => 1,
            Channel::Alpha => 2,
        }
    }
    /// A subscriber to `self` receives releases of channel `c`.
    pub fn includes(self, c: Channel) -> bool {
        c.rank() <= self.rank()
    }
}

pub fn classify(r: &GhRelease) -> Channel {
    let tag = r.tag_name.to_ascii_lowercase();
    if !r.prerelease && !tag.contains('-') {
        Channel::Stable
    } else if tag.contains("beta") || tag.contains("-rc") || tag.contains(".rc") {
        Channel::Beta
    } else if !r.prerelease && !(tag.contains("alpha") || tag.contains("dev") || tag.contains("nightly")) {
        // A non-prerelease tag with a suffix we don't recognise is treated as stable.
        Channel::Stable
    } else {
        Channel::Alpha
    }
}

pub fn parse_version(tag: &str) -> Option<semver::Version> {
    let t = tag.trim().trim_start_matches(['v', 'V']);
    semver::Version::parse(t).ok()
}

pub fn compare_tags(a: &str, b: &str) -> Ordering {
    match (parse_version(a), parse_version(b)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => a.cmp(b),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RateInfo {
    pub limit: Option<u64>,
    pub remaining: Option<u64>,
    pub reset: Option<u64>,
    pub authenticated: bool,
    pub last_status: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CacheEntry {
    etag: Option<String>,
    fetched_at: u64,
    releases: Vec<GhRelease>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasesResult {
    pub releases: Vec<GhRelease>,
    pub fetched_at: u64,
    /// "network" | "not-modified" | "cache" | "stale-cache"
    pub source: &'static str,
    pub warning: Option<String>,
}

pub struct GithubClient {
    http: reqwest::Client,
    cache_dir: PathBuf,
    token: Option<String>,
    mem: Mutex<HashMap<String, CacheEntry>>,
    rate: Mutex<RateInfo>,
}

impl GithubClient {
    pub fn new(http: reqwest::Client, cache_dir: PathBuf) -> Self {
        let token = ["GITHUB_TOKEN", "GH_TOKEN"]
            .iter()
            .filter_map(|k| std::env::var(k).ok())
            .map(|s| s.trim().to_string())
            .find(|s| !s.is_empty());
        let rate = RateInfo { authenticated: token.is_some(), ..Default::default() };
        Self { http, cache_dir, token, mem: Mutex::new(HashMap::new()), rate: Mutex::new(rate) }
    }

    pub fn rate_info(&self) -> RateInfo {
        self.rate.lock().unwrap().clone()
    }

    pub fn clear_cache(&self) -> std::io::Result<()> {
        self.mem.lock().unwrap().clear();
        let dir = self.cache_dir.join("github");
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        Ok(())
    }

    fn cache_file(&self, repo: &str) -> PathBuf {
        self.cache_dir.join("github").join(format!("{}.json", repo.replace('/', "__")))
    }

    fn cached(&self, repo: &str) -> Option<CacheEntry> {
        if let Some(e) = self.mem.lock().unwrap().get(repo) {
            return Some(e.clone());
        }
        let path = self.cache_file(repo);
        if !path.exists() {
            return None;
        }
        let e: CacheEntry = load_json(&path);
        self.mem.lock().unwrap().insert(repo.to_string(), e.clone());
        Some(e)
    }

    fn store(&self, repo: &str, e: CacheEntry) {
        let _ = save_json(&self.cache_file(repo), &e);
        self.mem.lock().unwrap().insert(repo.to_string(), e);
    }

    fn update_rate(&self, headers: &HeaderMap, status: StatusCode) {
        let num = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
        let mut r = self.rate.lock().unwrap();
        if let Some(v) = num("x-ratelimit-limit") { r.limit = Some(v); }
        if let Some(v) = num("x-ratelimit-remaining") { r.remaining = Some(v); }
        if let Some(v) = num("x-ratelimit-reset") { r.reset = Some(v); }
        if let Some(secs) = num("retry-after") {
            r.remaining = Some(0);
            r.reset = Some(now_secs() + secs);
        }
        r.last_status = Some(status.as_u16());
    }

    fn rate_limited_until(&self) -> Option<u64> {
        let r = self.rate.lock().unwrap();
        match (r.remaining, r.reset) {
            (Some(0), Some(reset)) if reset > now_secs() => Some(reset),
            _ => None,
        }
    }

    fn stale(e: CacheEntry, warning: String) -> ReleasesResult {
        ReleasesResult { releases: e.releases, fetched_at: e.fetched_at, source: "stale-cache", warning: Some(warning) }
    }

    /// Fetch the non-draft releases of `repo`, newest first as GitHub returns them.
    pub async fn releases(&self, repo: &str, force: bool) -> anyhow::Result<ReleasesResult> {
        let cached = self.cached(repo);
        let now = now_secs();

        if !force {
            if let Some(c) = &cached {
                if now.saturating_sub(c.fetched_at) < FRESH_SECS {
                    return Ok(ReleasesResult {
                        releases: c.releases.clone(),
                        fetched_at: c.fetched_at,
                        source: "cache",
                        warning: None,
                    });
                }
            }
        }

        if let Some(reset) = self.rate_limited_until() {
            let msg = format!("GitHub API 已達請求上限，約 {} 分鐘後重置。", (reset - now).div_ceil(60));
            return match cached {
                Some(c) => Ok(Self::stale(c, format!("{msg}目前顯示快取資料。"))),
                None => bail!(msg),
            };
        }

        let url = format!("https://api.github.com/repos/{repo}/releases?per_page=50");
        let mut req = self
            .http
            .get(&url)
            .header(ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(t) = &self.token {
            req = req.bearer_auth(t);
        }
        if let Some(etag) = cached.as_ref().and_then(|c| c.etag.clone()) {
            req = req.header(IF_NONE_MATCH, etag);
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("無法連線至 GitHub：{}", short_err(&e));
                return match cached {
                    Some(c) => Ok(Self::stale(c, format!("{msg}（顯示快取資料）"))),
                    None => Err(anyhow!(msg)),
                };
            }
        };
        let status = resp.status();
        self.update_rate(resp.headers(), status);

        match status {
            StatusCode::NOT_MODIFIED => {
                let mut c = cached.ok_or_else(|| anyhow!("GitHub 回傳 304 但沒有快取"))?;
                c.fetched_at = now;
                self.store(repo, c.clone());
                Ok(ReleasesResult { releases: c.releases, fetched_at: now, source: "not-modified", warning: None })
            }
            s if s.is_success() => {
                let etag = resp.headers().get(ETAG).and_then(|v| v.to_str().ok()).map(String::from);
                let mut releases: Vec<GhRelease> = resp.json().await?;
                releases.retain(|r| !r.draft);
                let e = CacheEntry { etag, fetched_at: now, releases: releases.clone() };
                self.store(repo, e);
                Ok(ReleasesResult { releases, fetched_at: now, source: "network", warning: None })
            }
            StatusCode::NOT_FOUND => {
                Ok(ReleasesResult { releases: vec![], fetched_at: now, source: "network", warning: Some(format!("找不到 GitHub Repository：{repo}")) })
            }
            StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => {
                let msg = match self.rate_limited_until() {
                    Some(reset) => format!("GitHub API 已達請求上限，約 {} 分鐘後重置。", (reset - now).div_ceil(60)),
                    None => format!("GitHub 拒絕請求（HTTP {}）。", status.as_u16()),
                };
                match cached {
                    Some(c) => Ok(Self::stale(c, format!("{msg}目前顯示快取資料。"))),
                    None => bail!(msg),
                }
            }
            other => {
                let msg = format!("GitHub 回應錯誤 HTTP {}", other.as_u16());
                match cached {
                    Some(c) => Ok(Self::stale(c, msg)),
                    None => bail!(msg),
                }
            }
        }
    }
}

pub fn short_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "連線逾時".into()
    } else if e.is_connect() {
        "無法建立連線".into()
    } else {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rel(tag: &str, pre: bool) -> GhRelease {
        GhRelease { tag_name: tag.into(), name: None, prerelease: pre, draft: false, published_at: None, html_url: String::new(), body: None, assets: vec![] }
    }
    #[test]
    fn channels() {
        assert_eq!(classify(&rel("v0.3.1", false)), Channel::Stable);
        assert_eq!(classify(&rel("v0.2.1-alpha", true)), Channel::Alpha);
        assert_eq!(classify(&rel("v1.0.0-beta.2", true)), Channel::Beta);
        assert_eq!(classify(&rel("v1.0.0-rc.1", true)), Channel::Beta);
        assert!(Channel::Beta.includes(Channel::Stable));
        assert!(!Channel::Stable.includes(Channel::Beta));
    }
    #[test]
    fn ordering() {
        assert_eq!(compare_tags("v0.3.1", "v0.3.0"), Ordering::Greater);
        assert_eq!(compare_tags("v0.3.0", "v0.3.0-alpha"), Ordering::Greater);
        assert_eq!(compare_tags("v0.2.1-alpha", "v0.10.0"), Ordering::Less);
    }
}
