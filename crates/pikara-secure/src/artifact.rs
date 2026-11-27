//! One streaming pass over a downloaded file: SHA-256 and the minisign (BLAKE2b-prehashed)
//! signature are computed together, so even multi-GB installers never sit in RAM.

use crate::{keys, SecureError};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

/// Streaming SHA-256 of a file.
pub fn sha256_file(path: &Path) -> Result<String, SecureError> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// Verify `path` against an expected SHA-256 **and** a minisign signature made with `pubkey`.
/// The SHA-256 is checked first; the signature is still required when the hash matches.
/// Returns the computed SHA-256 on success.
pub fn verify_file(path: &Path, expected_sha256: &str, signature: &str, pubkey: &str) -> Result<String, SecureError> {
    let expected = expected_sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(SecureError::Manifest("SHA-256 欄位格式錯誤".into()));
    }
    let pk = keys::public_key(pubkey)?;
    let sig = keys::signature(signature)?;
    let mut verifier = pk
        .verify_stream(&sig)
        .map_err(|e| SecureError::BadSignature(format!("{e}（只接受 prehashed 簽章，且金鑰 ID 必須相符）")))?;

    let mut f = std::fs::File::open(path)?;
    let mut sha = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
        verifier.update(&buf[..n]);
    }
    let actual = hex::encode(sha.finalize());
    if actual != expected {
        return Err(SecureError::Sha256Mismatch { expected, actual });
    }
    verifier.finalize().map_err(|e| SecureError::BadSignature(e.to_string()))?;
    Ok(actual)
}
