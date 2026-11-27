//! Verify a signed update.json exactly the way clients do (compiled-in key, strict checks).
//! Used by CI after signing and before publishing, and handy for manual audits.
//!
//! cargo run -p pikara-secure --example verify_manifest -- <update.json> <update.json.sig> <current-version>

use pikara_secure::keys::PIKARA_RELEASE_PUBKEY;
use pikara_secure::manifest::{verify, Policy, ReplayState, Verdict};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let json = std::fs::read(&a[1]).expect("update.json");
    let sig = std::fs::read_to_string(&a[2]).expect("update.json.sig");
    let current = a.get(3).map(String::as_str).unwrap_or("0.0.0");
    let mut ok = true;
    for platform_key in ["windows-x86_64", "darwin-aarch64", "darwin-x86_64"] {
        let policy = Policy {
            product: "create-your-world",
            pubkey: PIKARA_RELEASE_PUBKEY,
            current_version: current,
            release_prefix: "https://github.com/eddiesu9420minecraft-wq/CreateYourWorld/releases/download/",
            platform_key,
        };
        match verify(&json, &sig, &policy, &ReplayState::default()) {
            Ok((Verdict::Update { manifest, entry }, _)) => println!("{platform_key}: OK → {} {}", manifest.version, entry.url),
            Ok((Verdict::UpToDate { latest }, _)) => println!("{platform_key}: OK (up to date at {latest})"),
            Err(e) => {
                ok = false;
                eprintln!("{platform_key}: REJECTED: {e}");
            }
        }
    }
    std::process::exit(if ok { 0 } else { 1 });
}
