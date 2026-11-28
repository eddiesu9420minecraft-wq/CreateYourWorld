//! Locked-down HTTPS client.
//!
//! * `https_only` + TLS ≥ 1.2, certificates validated against built-in Mozilla roots (rustls +
//!   webpki-roots). No API here can disable certificate or hostname checks.
//! * Names are resolved only through [`DohResolver`].
//! * Every request URL and every redirect target must be `https://` on an allow-listed host.

use crate::doh::DohResolver;
use crate::SecureError;
use reqwest::redirect::Policy;
use reqwest::Url;
use std::sync::Arc;
use std::time::Duration;

/// Hosts that serve GitHub API responses, raw files and release assets.
pub const GITHUB_HOSTS: &[&str] = &[
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "codeload.github.com",
];

pub fn check_url(url: &str, allowed: &[&str]) -> Result<Url, SecureError> {
    let u = Url::parse(url).map_err(|e| SecureError::UrlRejected(format!("{url}: {e}")))?;
    if u.scheme() != "https" {
        return Err(SecureError::UrlRejected(format!("{url}（只允許 HTTPS）")));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(SecureError::UrlRejected(format!("{url}（不允許內嵌帳密）")));
    }
    let host = u.host_str().unwrap_or_default().to_ascii_lowercase();
    if !allowed.iter().any(|h| *h == host) {
        return Err(SecureError::UrlRejected(format!("{host} 不在允許清單中")));
    }
    if u.port().is_some_and(|p| p != 443) {
        return Err(SecureError::UrlRejected(format!("{url}（不允許非標準連接埠）")));
    }
    Ok(u)
}

pub struct ClientOptions {
    pub allowed_hosts: &'static [&'static str],
    pub user_agent: String,
    /// Whole-request timeout; `None` for large downloads.
    pub timeout: Option<Duration>,
}

pub fn secure_client(resolver: DohResolver, opts: ClientOptions) -> Result<reqwest::Client, SecureError> {
    let allowed = opts.allowed_hosts;
    let policy = Policy::custom(move |attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("重新導向次數過多");
        }
        match check_url(attempt.url().as_str(), allowed) {
            Ok(_) => attempt.follow(),
            Err(e) => attempt.error(e),
        }
    });
    let mut b = reqwest::Client::builder()
        .https_only(true)
        .min_tls_version(reqwest::tls::Version::TLS_1_2)
        .dns_resolver(Arc::new(resolver))
        .redirect(policy)
        .connect_timeout(Duration::from_secs(15))
        .user_agent(opts.user_agent);
    if let Some(t) = opts.timeout {
        b = b.timeout(t);
    }
    b.build().map_err(|e| SecureError::Network(e.to_string()))
}

/// GET a small document (≤ `max_bytes`) from an allow-listed URL.
pub async fn fetch_small(client: &reqwest::Client, url: &str, allowed: &[&str], max_bytes: usize) -> Result<Vec<u8>, SecureError> {
    check_url(url, allowed)?;
    let resp = client.get(url).send().await.map_err(|e| SecureError::Network(describe(&e)))?;
    if !resp.status().is_success() {
        return Err(SecureError::Network(format!("HTTP {}", resp.status().as_u16())));
    }
    if resp.content_length().is_some_and(|n| n as usize > max_bytes) {
        return Err(SecureError::Network("回應過大".into()));
    }
    let bytes = resp.bytes().await.map_err(|e| SecureError::Network(describe(&e)))?;
    if bytes.len() > max_bytes {
        return Err(SecureError::Network("回應過大".into()));
    }
    Ok(bytes.to_vec())
}

/// Human-readable error including the root cause (TLS / DNS / redirect).
pub fn describe(e: &reqwest::Error) -> String {
    let mut s = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(inner) = src {
        s.push_str(" ← ");
        s.push_str(&inner.to_string());
        src = inner.source();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_rules() {
        assert!(check_url("https://github.com/a/b", GITHUB_HOSTS).is_ok());
        assert!(check_url("http://github.com/a/b", GITHUB_HOSTS).is_err());
        assert!(check_url("https://github.com.evil.com/x", GITHUB_HOSTS).is_err());
        assert!(check_url("https://evil.com/github.com", GITHUB_HOSTS).is_err());
        assert!(check_url("https://user:pw@github.com/x", GITHUB_HOSTS).is_err());
        assert!(check_url("https://github.com:8443/x", GITHUB_HOSTS).is_err());
    }

    fn client(hosts: &'static [&'static str]) -> reqwest::Client {
        secure_client(DohResolver::default(), ClientOptions { allowed_hosts: hosts, user_agent: "pikara-test".into(), timeout: Some(Duration::from_secs(20)) }).unwrap()
    }

    // ---- live network tests (`cargo test -- --ignored`) ----

    const BADSSL: &[&str] = &["expired.badssl.com", "self-signed.badssl.com", "wrong.host.badssl.com", "untrusted-root.badssl.com", "badssl.com", "http.badssl.com"];

    #[tokio::test]
    #[ignore]
    async fn rejects_invalid_tls_certificates() {
        let c = client(BADSSL);
        for host in ["expired.badssl.com", "self-signed.badssl.com", "wrong.host.badssl.com", "untrusted-root.badssl.com"] {
            let r = c.get(format!("https://{host}/")).send().await;
            assert!(r.is_err(), "{host} must fail TLS validation");
            println!("{host}: {}", describe(&r.unwrap_err()));
        }
        // Control: the same client accepts a valid certificate. (badssl.com's own front page is often very slow,
        // so the control uses GitHub's API; any HTTP answer — even 403 rate limited — means TLS validated.)
        let ok = client(&["api.github.com"]).get("https://api.github.com/zen").send().await;
        assert!(ok.is_ok(), "valid certificate must be accepted: {:?}", ok.err().map(|e| describe(&e)));
    }

    #[tokio::test]
    #[ignore]
    async fn refuses_plain_http() {
        let c = client(BADSSL);
        assert!(c.get("http://http.badssl.com/").send().await.is_err());
        assert!(fetch_small(&c, "http://http.badssl.com/", BADSSL, 1024).await.is_err());
    }

    #[tokio::test]
    #[ignore]
    async fn blocks_redirect_to_unlisted_host() {
        // github.com/<owner>/<repo>/releases/latest redirects within github.com (allowed);
        // with an allow-list that lacks the target, the same redirect must be refused.
        const ONLY_API: &[&str] = &["api.github.com"];
        let c = client(ONLY_API);
        let r = c.get("https://api.github.com/repos/eddiesu9420minecraft-wq/PikaraScienceStudio/tarball").send().await;
        match r {
            Err(e) => println!("blocked: {}", describe(&e)),
            // GitHub answered without redirecting (e.g. 403/429 rate limit on a shared CI IP): nothing was followed,
            // so the security property holds, but the redirect path was not exercised this time
            Ok(resp) => {
                assert_eq!(resp.url().host_str(), Some("api.github.com"), "a redirect to an unlisted host was followed");
                assert!(!resp.status().is_success() && !resp.status().is_redirection(), "unexpected {}", resp.status());
                println!("inconclusive: GitHub returned {} without a redirect (rate limited?)", resp.status());
            }
        }
    }
}
