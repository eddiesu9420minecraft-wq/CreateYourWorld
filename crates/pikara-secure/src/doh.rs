//! DNS-over-HTTPS resolver.
//!
//! * DoH providers are reached through **fixed bootstrap IPs**, while TLS still verifies the
//!   provider's real hostname (SNI + certificate) — so the system resolver is never consulted.
//! * Providers are tried in order (Cloudflare, then Google); any failure falls through.
//! * A and AAAA are queried in parallel; answers are cached for their TTL (clamped 30 s–1 h).
//! * Answers pointing at private / loopback / link-local space are rejected (DNS rebinding).
//! * No GitHub (or any target) IP is hard-coded: only the DoH providers' anycast addresses.

use crate::SecureError;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde::Deserialize;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct Provider {
    pub name: &'static str,
    /// Hostname used for SNI, Host header and certificate validation.
    pub host: &'static str,
    /// JSON DoH endpoint (`?name=…&type=…` is appended).
    pub endpoint: &'static str,
    pub bootstrap: Vec<IpAddr>,
}

impl Provider {
    pub fn cloudflare() -> Self {
        Self {
            name: "Cloudflare",
            host: "cloudflare-dns.com",
            endpoint: "https://cloudflare-dns.com/dns-query",
            bootstrap: vec![
                IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)),
                IpAddr::V4(Ipv4Addr::new(1, 0, 0, 1)),
                IpAddr::V6("2606:4700:4700::1111".parse().unwrap()),
                IpAddr::V6("2606:4700:4700::1001".parse().unwrap()),
            ],
        }
    }
    pub fn google() -> Self {
        Self {
            name: "Google",
            host: "dns.google",
            endpoint: "https://dns.google/resolve",
            bootstrap: vec![
                IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)),
                IpAddr::V4(Ipv4Addr::new(8, 8, 4, 4)),
                IpAddr::V6("2001:4860:4860::8888".parse().unwrap()),
                IpAddr::V6("2001:4860:4860::8844".parse().unwrap()),
            ],
        }
    }
}

struct Backend {
    provider: Provider,
    client: reqwest::Client,
}

struct CacheEntry {
    addrs: Vec<IpAddr>,
    expires: Instant,
    provider: &'static str,
}

struct Inner {
    backends: Vec<Backend>,
    cache: Mutex<HashMap<String, CacheEntry>>,
}

/// Cheap to clone; implements [`reqwest::dns::Resolve`].
#[derive(Clone)]
pub struct DohResolver {
    inner: Arc<Inner>,
}

#[derive(Debug, Clone)]
pub struct Lookup {
    pub addrs: Vec<IpAddr>,
    pub provider: &'static str,
    pub cached: bool,
}

#[derive(Deserialize)]
struct DohAnswer {
    #[serde(rename = "type")]
    rtype: u16,
    #[serde(rename = "TTL", default)]
    ttl: u32,
    data: String,
}

#[derive(Deserialize)]
struct DohResponse {
    #[serde(rename = "Status")]
    status: u32,
    #[serde(rename = "Answer", default)]
    answer: Vec<DohAnswer>,
}

impl Default for DohResolver {
    fn default() -> Self {
        Self::new(vec![Provider::cloudflare(), Provider::google()])
    }
}

impl DohResolver {
    pub fn new(providers: Vec<Provider>) -> Self {
        let backends = providers
            .into_iter()
            .map(|p| {
                let addrs: Vec<SocketAddr> = p.bootstrap.iter().map(|ip| SocketAddr::new(*ip, 443)).collect();
                let client = reqwest::Client::builder()
                    .https_only(true)
                    .min_tls_version(reqwest::tls::Version::TLS_1_2)
                    // The only host this client ever contacts is pinned to bootstrap IPs.
                    .resolve_to_addrs(p.host, &addrs)
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(3))
                    .timeout(Duration::from_secs(6))
                    .user_agent("PikaraSecureNetwork/0.1")
                    .build()
                    .expect("DoH client");
                Backend { provider: p, client }
            })
            .collect();
        Self { inner: Arc::new(Inner { backends, cache: Mutex::new(HashMap::new()) }) }
    }

    pub fn clear_cache(&self) {
        self.inner.cache.lock().unwrap().clear();
    }

    async fn query(b: &Backend, host: &str, rtype: &str) -> Result<(u32, Vec<(IpAddr, u32)>), String> {
        let url = format!("{}?name={}&type={}", b.provider.endpoint, host, rtype);
        let resp = b
            .client
            .get(url)
            .header("accept", "application/dns-json")
            .send()
            .await
            .map_err(|e| format!("{}: {e}", b.provider.name))?;
        if !resp.status().is_success() {
            return Err(format!("{}: HTTP {}", b.provider.name, resp.status().as_u16()));
        }
        let body: DohResponse = resp.json().await.map_err(|e| format!("{}: {e}", b.provider.name))?;
        let want = if rtype == "A" { 1 } else { 28 };
        let ips = body
            .answer
            .iter()
            .filter(|a| a.rtype == want)
            .filter_map(|a| a.data.parse::<IpAddr>().ok().map(|ip| (ip, a.ttl)))
            .collect();
        Ok((body.status, ips))
    }

    /// Resolve `host` via DoH only.
    pub async fn lookup(&self, host: &str) -> Result<Lookup, SecureError> {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        if let Ok(ip) = host.parse::<IpAddr>() {
            return Ok(Lookup { addrs: vec![ip], provider: "literal", cached: false });
        }
        if !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') || host.is_empty() {
            return Err(SecureError::Resolution(format!("無效的主機名稱：{host}")));
        }
        if let Some(e) = self.inner.cache.lock().unwrap().get(&host) {
            if e.expires > Instant::now() {
                return Ok(Lookup { addrs: e.addrs.clone(), provider: e.provider, cached: true });
            }
        }

        let mut errors = vec![];
        for b in &self.inner.backends {
            let (a, aaaa) = tokio::join!(Self::query(b, &host, "A"), Self::query(b, &host, "AAAA"));
            let (sa, ra) = match a {
                Ok(v) => v,
                Err(e) => {
                    errors.push(e);
                    if aaaa.is_err() {
                        continue; // provider unreachable: fail over
                    }
                    (0, vec![])
                }
            };
            let (s6, r6) = aaaa.unwrap_or((sa, vec![]));
            if sa == 3 && s6 == 3 {
                return Err(SecureError::NxDomain(host));
            }
            if sa != 0 && s6 != 0 {
                errors.push(format!("{}: DNS status {sa}/{s6}", b.provider.name));
                continue;
            }
            let all: Vec<(IpAddr, u32)> = ra.into_iter().chain(r6).collect();
            if all.is_empty() {
                errors.push(format!("{}: 沒有 A/AAAA 記錄", b.provider.name));
                continue;
            }
            let public: Vec<(IpAddr, u32)> = all.iter().copied().filter(|(ip, _)| is_public(ip)).collect();
            if public.is_empty() {
                errors.push(format!("{}: 回傳的位址全為非公開 IP，已拒絕", b.provider.name));
                continue;
            }
            let ttl = public.iter().map(|(_, t)| *t).min().unwrap_or(60).clamp(30, 3600);
            let addrs: Vec<IpAddr> = public.into_iter().map(|(ip, _)| ip).collect();
            self.inner.cache.lock().unwrap().insert(
                host.clone(),
                CacheEntry { addrs: addrs.clone(), expires: Instant::now() + Duration::from_secs(ttl as u64), provider: b.provider.name },
            );
            return Ok(Lookup { addrs, provider: b.provider.name, cached: false });
        }
        Err(SecureError::Resolution(errors.join("；")))
    }
}

impl Resolve for DohResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let this = self.clone();
        let host = name.as_str().to_string();
        Box::pin(async move {
            let l = this.lookup(&host).await.map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;
            let it: Addrs = Box::new(l.addrs.into_iter().map(|ip| SocketAddr::new(ip, 0)));
            Ok(it)
        })
    }
}

/// Globally routable unicast only (std's `is_global` is unstable).
pub fn is_public(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xC0) == 64) // 100.64.0.0/10 CGNAT
                || (o[0] == 198 && (o[1] & 0xFE) == 18) // 198.18.0.0/15 benchmarking
                || o[0] >= 240)
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(&IpAddr::V4(v4));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xFE00) == 0xFC00 // unique local
                || (s[0] & 0xFFC0) == 0xFE80 // link local
                || (s[0] == 0x2001 && s[1] == 0x0DB8) // documentation
                || *v6 == Ipv6Addr::UNSPECIFIED)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_filter() {
        for bad in ["10.0.0.1", "127.0.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"] {
            assert!(!is_public(&bad.parse().unwrap()), "{bad}");
        }
        for good in ["140.82.112.3", "185.199.108.133", "2606:50c0:8000::154"] {
            assert!(is_public(&good.parse().unwrap()), "{good}");
        }
    }

    // ---- live network tests (run with `cargo test -- --ignored`) ----

    #[tokio::test]
    #[ignore]
    async fn resolves_github_over_doh_with_cache() {
        let r = DohResolver::default();
        let a = r.lookup("api.github.com").await.unwrap();
        assert!(!a.addrs.is_empty() && !a.cached);
        let b = r.lookup("api.github.com").await.unwrap();
        assert!(b.cached);
        println!("api.github.com via {} → {:?}", a.provider, a.addrs);
    }

    #[tokio::test]
    #[ignore]
    async fn fails_over_when_first_provider_is_down() {
        // TEST-NET-1 address: guaranteed unroutable, so the first provider times out.
        let mut dead = Provider::cloudflare();
        dead.bootstrap = vec!["192.0.2.1".parse().unwrap()];
        let r = DohResolver::new(vec![dead, Provider::google()]);
        let l = r.lookup("raw.githubusercontent.com").await.unwrap();
        assert_eq!(l.provider, "Google");
    }

    #[tokio::test]
    #[ignore]
    async fn nxdomain_is_reported() {
        let r = DohResolver::default();
        let e = r.lookup("does-not-exist-pikara-7f3a9c.invalid").await.unwrap_err();
        assert!(matches!(e, SecureError::NxDomain(_) | SecureError::Resolution(_)), "{e:?}");
    }

    #[tokio::test]
    #[ignore]
    async fn all_providers_down_is_an_error() {
        let mut a = Provider::cloudflare();
        a.bootstrap = vec!["192.0.2.1".parse().unwrap()];
        let mut b = Provider::google();
        b.bootstrap = vec!["192.0.2.2".parse().unwrap()];
        let r = DohResolver::new(vec![a, b]);
        assert!(matches!(r.lookup("github.com").await, Err(SecureError::Resolution(_))));
    }
}
