//! Verify one release file against its `.sig` with the compiled-in Pikara key.
//! cargo run -p pikara-secure --example verify_artifact -- <file> [<file.sig>]
use pikara_secure::artifact::{sha256_file, verify_file};
use pikara_secure::keys::PIKARA_RELEASE_PUBKEY;
use std::path::Path;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let file = Path::new(&a[1]);
    let sig_path = a.get(2).cloned().unwrap_or_else(|| format!("{}.sig", a[1]));
    let sig = std::fs::read_to_string(&sig_path).expect("signature file");
    let sha = sha256_file(file).expect("read file");
    match verify_file(file, &sha, &sig, PIKARA_RELEASE_PUBKEY) {
        Ok(_) => println!("OK  sha256={sha}  signature valid (Pikara release key)"),
        Err(e) => {
            eprintln!("REJECTED: {e}");
            std::process::exit(1);
        }
    }
}
