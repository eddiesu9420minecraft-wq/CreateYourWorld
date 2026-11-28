//! The real runX plugin index (fixture copied from the published runX repo) against the compiled-in key.
use cyw_core::plugins::verify_index;
use pikara_secure::keys::PIKARA_RELEASE_PUBKEY;

const INDEX: &[u8] = include_bytes!("fixtures/plugins.json");
const SIG: &str = include_str!("fixtures/plugins.json.sig");

fn scratch() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("cyw-plugin-sec-{}", std::process::id()))
}

#[test]
fn published_index_verifies_with_the_pikara_key() {
    let ix = verify_index(INDEX, SIG, "runX", PIKARA_RELEASE_PUBKEY, &scratch()).unwrap();
    assert!(ix.plugins.iter().any(|p| p.id == "runX-Examples"));
}

#[test]
fn one_changed_byte_is_rejected() {
    let mut bad = INDEX.to_vec();
    let i = bad.iter().position(|&b| b == b'1').unwrap();
    bad[i] = b'2'; // e.g. a size or a version digit
    let e = verify_index(&bad, SIG, "runX", PIKARA_RELEASE_PUBKEY, &scratch()).unwrap_err().to_string();
    assert!(e.contains("簽章"), "{e}");
}

#[test]
fn an_index_for_another_software_is_rejected_even_if_signed() {
    let e = verify_index(INDEX, SIG, "PikaraScienceStudio", PIKARA_RELEASE_PUBKEY, &scratch()).unwrap_err().to_string();
    assert!(e.contains("不是 PikaraScienceStudio"), "{e}");
}

#[test]
fn a_garbage_or_missing_signature_is_rejected() {
    assert!(verify_index(INDEX, "not a signature", "runX", PIKARA_RELEASE_PUBKEY, &scratch()).is_err());
    assert!(verify_index(INDEX, "", "runX", PIKARA_RELEASE_PUBKEY, &scratch()).is_err());
}
