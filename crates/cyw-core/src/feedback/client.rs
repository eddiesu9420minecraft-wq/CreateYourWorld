//! HTTP client for the Feedback Center backend (`services/feedback`, contract `docs/feedback/API.md`).
//!
//! * Production endpoint: `https://<host>` only, through Pikara Secure Network (DoH, TLS ≥ 1.2, host allow-list
//!   holding exactly that host). Configured at build time (`CYW_FEEDBACK_API`) or with `PIKARA_CYW_FEEDBACK_API`.
//! * Local development: `http://127.0.0.1:<port>` / `http://[::1]:<port>` / `http://localhost:<port>` only; no
//!   proxy, no redirects. Any other `http://` URL is refused.
//! * The session token is sent only to the backend it was issued by.

use anyhow::{anyhow, bail, Context, Result};
use pikara_secure::doh::DohResolver;
use pikara_secure::net::{self, ClientOptions};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

pub const ENV_API: &str = "PIKARA_CYW_FEEDBACK_API";

/// Backend base URL, if one is configured (none until the backend is deployed).
pub fn configured_base() -> Option<String> {
    std::env::var(ENV_API).ok().filter(|s| !s.trim().is_empty()).or_else(|| option_env!("CYW_FEEDBACK_API").map(str::to_string)).map(|s| s.trim().trim_end_matches('/').to_string())
}

/// Validate a base URL against the rules above.
pub fn validate_base(base: &str) -> Result<Url> {
    let u = Url::parse(base).with_context(|| format!("反饋服務網址無效：{base}"))?;
    if !u.username().is_empty() || u.password().is_some() {
        bail!("反饋服務網址不可內嵌帳密");
    }
    if u.query().is_some() || u.fragment().is_some() || !(u.path() == "/" || u.path().is_empty()) {
        bail!("反饋服務網址只能是 https://主機（不含路徑）");
    }
    match u.scheme() {
        "https" => {
            if u.port().is_some_and(|p| p != 443) {
                bail!("反饋服務不允許非標準連接埠");
            }
            Ok(u)
        }
        "http" if is_loopback(&u) => Ok(u),
        "http" => bail!("反饋服務只允許 HTTPS（http 僅限本機開發 127.0.0.1）"),
        s => bail!("不支援的通訊協定：{s}"),
    }
}

fn is_loopback(u: &Url) -> bool {
    match u.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub retry_after: Option<u64>,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.retry_after {
            Some(s) => write!(f, "{}（{}，{} 秒後再試）", self.message, self.code, s),
            None => write!(f, "{}（{}）", self.message, self.code),
        }
    }
}
impl std::error::Error for ApiError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    /// Backend this session belongs to (never sent anywhere else).
    pub base: String,
    pub token: String,
    pub expires_at: i64,
    pub user: Value,
}

#[derive(Clone)]
pub struct Client {
    base: Url,
    http: reqwest::Client,
}

impl Client {
    pub fn new(base: &str, resolver: DohResolver) -> Result<Self> {
        let u = validate_base(base)?;
        let http = if u.scheme() == "https" {
            let host = u.host_str().ok_or_else(|| anyhow!("缺少主機"))?.to_ascii_lowercase();
            // the allow-list must be 'static; one small leak per configured host for the process lifetime
            let hosts: &'static [&'static str] = Box::leak(vec![&*Box::leak(host.into_boxed_str())].into_boxed_slice());
            net::secure_client(resolver, ClientOptions { allowed_hosts: hosts, user_agent: format!("CreateYourWorld/{}", crate::VERSION), timeout: Some(Duration::from_secs(30)) })?
        } else {
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .user_agent(format!("CreateYourWorld/{}", crate::VERSION))
                .build()?
        };
        Ok(Self { base: u, http })
    }

    pub fn base(&self) -> String {
        self.base.as_str().trim_end_matches('/').to_string()
    }

    fn url(&self, path: &str, query: &[(String, String)]) -> Result<Url> {
        check_path(path)?;
        let mut u = self.base.join(path)?;
        if !query.is_empty() {
            u.query_pairs_mut().extend_pairs(query.iter());
        }
        // `join` must never leave the configured origin
        if u.origin() != self.base.origin() {
            bail!("路徑不允許離開反饋服務");
        }
        Ok(u)
    }

    /// JSON request. `token` is the session for this backend (if signed in).
    pub async fn json(&self, method: Method, path: &str, query: &[(String, String)], body: Option<&Value>, token: Option<&str>) -> Result<(u16, Value)> {
        let mut req = self.http.request(method, self.url(path, query)?);
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| anyhow!("無法連線到反饋服務：{}", net::describe(&e)))?;
        read(resp).await
    }

    /// Raw upload (attachments).
    pub async fn upload(&self, path: &str, content_type: &str, filename: &str, bytes: Vec<u8>, token: &str) -> Result<(u16, Value)> {
        let resp = self
            .http
            .post(self.url(path, &[])?)
            .bearer_auth(token)
            .header("Content-Type", content_type)
            .header("X-Filename", sanitize_filename(filename))
            .body(bytes)
            .send()
            .await
            .map_err(|e| anyhow!("無法連線到反饋服務：{}", net::describe(&e)))?;
        read(resp).await
    }

    /// Raw download (attachments), bounded.
    pub async fn download(&self, path: &str, token: &str, max: usize) -> Result<(String, Vec<u8>)> {
        let resp = self.http.get(self.url(path, &[])?).bearer_auth(token).send().await.map_err(|e| anyhow!("無法連線到反饋服務：{}", net::describe(&e)))?;
        if !resp.status().is_success() {
            let (_, v) = read(resp).await?;
            return Err(api_error(0, &v).into());
        }
        let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
        if resp.content_length().is_some_and(|n| n as usize > max) {
            bail!("附件過大");
        }
        let b = resp.bytes().await?;
        if b.len() > max {
            bail!("附件過大");
        }
        Ok((ct, b.to_vec()))
    }
}

async fn read(resp: reqwest::Response) -> Result<(u16, Value)> {
    let status = resp.status().as_u16();
    let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok());
    let bytes = resp.bytes().await?;
    if bytes.len() > 4 * 1024 * 1024 {
        bail!("反饋服務回應過大");
    }
    let v: Value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
    if status >= 400 {
        let mut e = api_error(status, &v);
        e.retry_after = retry_after;
        return Err(e.into());
    }
    Ok((status, v))
}

fn api_error(status: u16, v: &Value) -> ApiError {
    let code = v["error"]["code"].as_str().unwrap_or("http_error").to_string();
    let message = v["error"]["message"].as_str().map(str::to_string).unwrap_or_else(|| format!("反饋服務回應 HTTP {status}"));
    ApiError { status, code, message, retry_after: None }
}

/// API paths only: `/v1/…`, no traversal, no scheme/authority tricks, no encoded separators.
pub fn check_path(path: &str) -> Result<()> {
    let ok = path.starts_with("/v1/")
        && path.len() <= 200
        && path.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
        && !path.split('/').any(|seg| seg == ".." || seg == ".")
        && !path.contains("//");
    if !ok {
        bail!("不允許的反饋服務路徑：{path}");
    }
    Ok(())
}

fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let s: String = base.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ')).take(100).collect();
    if s.trim().is_empty() { "attachment".into() } else { s }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_rules() {
        assert!(validate_base("https://feedback.example.workers.dev").is_ok());
        assert!(validate_base("http://127.0.0.1:8787").is_ok());
        assert!(validate_base("http://[::1]:8787").is_ok());
        assert!(validate_base("http://localhost:8787").is_ok());
        for bad in [
            "http://feedback.example.com",
            "http://127.0.0.1.evil.com",
            "http://192.168.1.2:8787",
            "https://u:p@feedback.example.com",
            "https://feedback.example.com:8443",
            "https://feedback.example.com/v1",
            "ftp://127.0.0.1",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert!(validate_base(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn path_rules() {
        for ok in ["/v1/feedback", "/v1/feedback/abc-123/comments", "/v1/tasks/t_1"] {
            assert!(check_path(ok).is_ok(), "{ok}");
        }
        for bad in ["/v1/../admin", "/v2/x", "v1/x", "//evil.com/v1/", "/v1/x?y=1", "/v1/%2e%2e/", "/v1/a//b", "https://evil.com/v1/", "/v1/./x"] {
            assert!(check_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn url_stays_on_origin() {
        let c = Client::new("http://127.0.0.1:9", DohResolver::default()).unwrap();
        let u = c.url("/v1/feedback", &[("q".into(), "a&b=c".into())]).unwrap();
        assert_eq!(u.as_str(), "http://127.0.0.1:9/v1/feedback?q=a%26b%3Dc");
    }

    #[test]
    fn filenames() {
        assert_eq!(sanitize_filename(r"C:\Users\alice\Desktop\shot 1.png"), "shot 1.png");
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("截圖.png"), ".png");
        assert_eq!(sanitize_filename("\r\nX-Evil: 1"), "X-Evil 1");
        assert_eq!(sanitize_filename(""), "attachment");
    }
}
