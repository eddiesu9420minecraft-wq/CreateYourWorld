//! Security tests: every attack must be rejected, and the honest case must pass.
//! Fixtures are produced by `tools/gen-secure-fixtures.sh` with throw-away test keys.

use pikara_secure::artifact::verify_file;
use pikara_secure::manifest::{verify, Policy, ReplayState, Verdict};
use pikara_secure::SecureError;
use std::path::PathBuf;

fn fx(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}
fn read(name: &str) -> Vec<u8> {
    std::fs::read(fx(name)).unwrap()
}
fn text(name: &str) -> String {
    String::from_utf8(read(name)).unwrap()
}

const PREFIX: &str = "https://github.com/eddiesu9420minecraft-wq/CreateYourWorld/releases/download/";

fn check(name: &str, current: &str, state: &ReplayState) -> Result<(Verdict, ReplayState), SecureError> {
    let key = text("test.pub");
    let policy = Policy { product: "create-your-world", pubkey: &key, current_version: current, release_prefix: PREFIX, platform_key: "windows-x86_64" };
    verify(&read(&format!("{name}.json")), &text(&format!("{name}.json.sig")), &policy, state)
}

#[test]
fn honest_manifest_is_accepted() {
    let (v, st) = check("good", "0.1.0", &ReplayState::default()).unwrap();
    assert!(matches!(v, Verdict::Update { .. }));
    assert_eq!(st.highest_version.as_deref(), Some("0.2.0"));
    // Same version installed → up to date, not an error.
    assert!(matches!(check("good", "0.2.0", &ReplayState::default()).unwrap().0, Verdict::UpToDate { .. }));
}

#[test]
fn forged_json_signed_by_attacker_key_is_rejected() {
    assert!(matches!(check("forged", "0.1.0", &ReplayState::default()), Err(SecureError::BadSignature(_))));
}

#[test]
fn tampered_json_is_rejected() {
    // Flip the artifact SHA-256 inside a correctly signed manifest.
    let key = text("test.pub");
    let mut json = text("good.json");
    let sha = text("artifact.sha256");
    let evil: String = sha.chars().rev().collect();
    json = json.replace(&sha, &evil);
    let policy = Policy { product: "create-your-world", pubkey: &key, current_version: "0.1.0", release_prefix: PREFIX, platform_key: "windows-x86_64" };
    let r = verify(json.as_bytes(), &text("good.json.sig"), &policy, &ReplayState::default());
    assert!(matches!(r, Err(SecureError::BadSignature(_))), "{r:?}");
    // Also: one changed byte in the version number.
    let bumped = text("good.json").replace("\"0.2.0\"", "\"9.2.0\"");
    assert!(matches!(verify(bumped.as_bytes(), &text("good.json.sig"), &policy, &ReplayState::default()), Err(SecureError::BadSignature(_))));
}

#[test]
fn unsigned_or_garbage_signature_is_rejected() {
    let key = text("test.pub");
    let policy = Policy { product: "create-your-world", pubkey: &key, current_version: "0.1.0", release_prefix: PREFIX, platform_key: "windows-x86_64" };
    assert!(verify(&read("good.json"), "", &policy, &ReplayState::default()).is_err());
    assert!(verify(&read("good.json"), "not a signature", &policy, &ReplayState::default()).is_err());
}

#[test]
fn release_key_does_not_accept_test_signatures() {
    // The compiled-in production key must not trust anything signed by other keys.
    let policy = Policy { product: "create-your-world", pubkey: pikara_secure::keys::PIKARA_RELEASE_PUBKEY, current_version: "0.1.0", release_prefix: PREFIX, platform_key: "windows-x86_64" };
    assert!(matches!(verify(&read("good.json"), &text("good.json.sig"), &policy, &ReplayState::default()), Err(SecureError::BadSignature(_))));
}

#[test]
fn malicious_downgrade_is_rejected() {
    let r = check("downgrade", "0.1.0", &ReplayState::default());
    assert!(matches!(r, Err(SecureError::Downgrade { .. })), "{r:?}");
}

#[test]
fn replay_of_older_manifest_is_rejected() {
    let seen_newer = ReplayState { highest_version: Some("0.3.0".into()), last_pub_date: Some("2026-12-05T00:00:00Z".into()) };
    assert!(matches!(check("good", "0.1.0", &seen_newer), Err(SecureError::Replay(_))));
    let seen_later_date = ReplayState { highest_version: Some("0.2.0".into()), last_pub_date: Some("2026-11-15T00:00:00Z".into()) };
    assert!(matches!(check("olddate", "0.1.0", &seen_later_date), Err(SecureError::Replay(_))));
}

#[test]
fn artifact_url_must_match_signed_version_and_be_https_github() {
    assert!(matches!(check("wrongtag", "0.1.0", &ReplayState::default()), Err(SecureError::UrlRejected(_))));
    assert!(matches!(check("httpurl", "0.1.0", &ReplayState::default()), Err(SecureError::UrlRejected(_))));
    assert!(matches!(check("evilhost", "0.1.0", &ReplayState::default()), Err(SecureError::UrlRejected(_))));
}

#[test]
fn manifest_for_another_product_is_rejected() {
    assert!(matches!(check("otherprod", "0.1.0", &ReplayState::default()), Err(SecureError::Manifest(_))));
}

#[test]
fn honest_artifact_passes() {
    let sha = verify_file(&fx("artifact.bin"), &text("artifact.sha256"), &text("artifact.bin.sig"), &text("test.pub")).unwrap();
    assert_eq!(sha, text("artifact.sha256"));
}

#[test]
fn tampered_artifact_is_rejected_by_sha256() {
    let dir = std::env::temp_dir().join(format!("pikara-secure-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("tampered.bin");
    let mut bytes = read("artifact.bin");
    bytes[150_000] ^= 0x01; // one flipped bit
    std::fs::write(&p, &bytes).unwrap();
    let r = verify_file(&p, &text("artifact.sha256"), &text("artifact.bin.sig"), &text("test.pub"));
    assert!(matches!(r, Err(SecureError::Sha256Mismatch { .. })), "{r:?}");

    // Attacker also replaces the expected SHA-256 with the tampered file's hash:
    // the hash now matches, but the signature still fails.
    let evil_sha = pikara_secure::artifact::sha256_file(&p).unwrap();
    let r = verify_file(&p, &evil_sha, &text("artifact.bin.sig"), &text("test.pub"));
    assert!(matches!(r, Err(SecureError::BadSignature(_))), "{r:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn artifact_signed_by_wrong_key_is_rejected() {
    let r = verify_file(&fx("artifact.bin"), &text("artifact.sha256"), &text("artifact.bin.attacker.sig"), &text("test.pub"));
    assert!(matches!(r, Err(SecureError::BadSignature(_))), "{r:?}");
}
