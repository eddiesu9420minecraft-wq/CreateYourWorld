//! Real "system DNS is poisoned" test. Run in CI after pointing the OS hosts file at a bogus
//! address:  PIKARA_TAMPERED_IP=10.255.255.1 cargo test -p pikara-secure --test dns_tamper -- --ignored --nocapture

use pikara_secure::doh::DohResolver;
use pikara_secure::keys::PIKARA_RELEASE_PUBKEY;
use pikara_secure::manifest::{verify, Policy, ReplayState};
use pikara_secure::net::{fetch_small, secure_client, ClientOptions, GITHUB_HOSTS};
use std::net::ToSocketAddrs;
use std::time::Duration;

const REPO_RAW: &str = "https://raw.githubusercontent.com/eddiesu9420minecraft-wq/CreateYourWorld/main";

#[tokio::test]
#[ignore]
async fn updates_still_work_when_system_dns_is_tampered() {
    let bogus = std::env::var("PIKARA_TAMPERED_IP").expect("set PIKARA_TAMPERED_IP to the poisoned address");

    // 1. Prove the system resolver really is poisoned.
    for host in ["api.github.com", "raw.githubusercontent.com", "github.com"] {
        let sys: Vec<String> = (host, 443).to_socket_addrs().unwrap().map(|a| a.ip().to_string()).collect();
        println!("system DNS {host} → {sys:?}");
        assert!(sys.contains(&bogus), "hosts-file tampering is not active for {host}");
    }

    // 2. A normal client that trusts system DNS cannot reach GitHub.
    let naive = reqwest::Client::builder().connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(8)).build().unwrap();
    let r = naive.get("https://api.github.com/").send().await;
    println!("system-DNS client: {:?}", r.as_ref().map(|r| r.status()).map_err(|e| e.to_string()));
    assert!(r.is_err(), "naive client should have been misdirected");

    // 3. Pikara Secure Network resolves via DoH and verifies everything end to end.
    let resolver = DohResolver::default();
    let l = resolver.lookup("raw.githubusercontent.com").await.unwrap();
    println!("DoH raw.githubusercontent.com via {} → {:?}", l.provider, l.addrs);
    assert!(!l.addrs.iter().any(|a| a.to_string() == bogus));
    let c = secure_client(resolver, ClientOptions { allowed_hosts: GITHUB_HOSTS, user_agent: "pikara-dns-tamper-test".into(), timeout: Some(Duration::from_secs(30)) }).unwrap();

    match fetch_small(&c, &format!("{REPO_RAW}/update.json"), GITHUB_HOSTS, 256 * 1024).await {
        Ok(json) => {
            let sig = String::from_utf8(fetch_small(&c, &format!("{REPO_RAW}/update.json.sig"), GITHUB_HOSTS, 16 * 1024).await.unwrap()).unwrap();
            let policy = Policy {
                product: "create-your-world",
                pubkey: PIKARA_RELEASE_PUBKEY,
                current_version: "0.0.1",
                release_prefix: "https://github.com/eddiesu9420minecraft-wq/CreateYourWorld/releases/download/",
                platform_key: "windows-x86_64",
            };
            let (v, _) = verify(&json, &sig, &policy, &ReplayState::default()).expect("signed update.json must verify");
            println!("update.json fetched over DoH and signature verified: {v:?}");
        }
        Err(e) => {
            // Before the first release there is no update.json yet; still prove HTTPS works.
            println!("update.json not available yet ({e}); checking the repository API instead");
            let r = c.get("https://api.github.com/repos/eddiesu9420minecraft-wq/CreateYourWorld").send().await.unwrap();
            assert!(r.status().is_success());
        }
    }
}
