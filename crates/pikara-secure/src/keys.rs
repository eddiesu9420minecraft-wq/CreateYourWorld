//! Trusted keys are compiled in. Nothing fetched over the network can add or replace them.

use crate::SecureError;
use base64::Engine;

/// Pikara release signing key (minisign; Tauri-updater base64 form). Key ID 13216449EEB947A5.
/// The matching private key lives only in protected GitHub Actions secrets and an offline copy.
pub const PIKARA_RELEASE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDEzMjE2NDQ5RUVCOTQ3QTUKUldTbFI3bnVTV1FoRTlzOUNDQUd6VU00SDhRNHJaUmpuNEhEbmJuUGV5dkFjd3hnLzhuYkNtNWUK";

/// Minisign material may be raw text or base64 of the text (Tauri's format).
fn maybe_b64_text(s: &str) -> String {
    let t = s.trim();
    if t.starts_with("untrusted comment:") {
        return t.to_string();
    }
    match base64::engine::general_purpose::STANDARD.decode(t) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) if text.starts_with("untrusted comment:") => text,
            _ => t.to_string(),
        },
        Err(_) => t.to_string(),
    }
}

pub fn public_key(s: &str) -> Result<minisign_verify::PublicKey, SecureError> {
    let text = maybe_b64_text(s);
    let r = if text.starts_with("untrusted comment:") {
        minisign_verify::PublicKey::decode(&text)
    } else {
        minisign_verify::PublicKey::from_base64(&text)
    };
    r.map_err(|e| SecureError::BadSignature(format!("公鑰格式錯誤：{e}")))
}

pub fn signature(s: &str) -> Result<minisign_verify::Signature, SecureError> {
    minisign_verify::Signature::decode(&maybe_b64_text(s)).map_err(|e| SecureError::BadSignature(format!("簽章格式錯誤：{e}")))
}

/// Verify a detached minisign signature over a small in-memory document (e.g. update.json).
pub fn verify_bytes(pubkey: &str, sig: &str, data: &[u8]) -> Result<(), SecureError> {
    let pk = public_key(pubkey)?;
    let sig = signature(sig)?;
    // `allow_legacy = false`: only prehashed (BLAKE2b) Ed25519 signatures are accepted.
    pk.verify(data, &sig, false).map_err(|e| SecureError::BadSignature(e.to_string()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn embedded_key_parses() {
        super::public_key(super::PIKARA_RELEASE_PUBKEY).unwrap();
    }
}
