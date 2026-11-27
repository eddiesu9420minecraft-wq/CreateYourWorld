//! Integrity (SHA-256) and authenticity (minisign signature) checks.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CheckStatus {
    Passed,
    Failed,
    /// The release does not publish this kind of proof.
    #[default]
    NotAvailable,
    /// The catalog has no signing key for this product.
    NotConfigured,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub status: CheckStatus,
    pub detail: String,
}

impl Check {
    pub fn new(status: CheckStatus, detail: impl Into<String>) -> Self {
        Self { status, detail: detail.into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub sha256: String,
    pub github_digest: Check,
    pub checksum_file: Check,
    pub signature: Check,
}

impl VerifyReport {
    pub fn any_failed(&self) -> bool {
        [&self.github_digest, &self.checksum_file, &self.signature]
            .iter()
            .any(|c| c.status == CheckStatus::Failed)
    }
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
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

/// Compare against GitHub's `digest` field (`sha256:<hex>`).
pub fn check_github_digest(actual: &str, digest: Option<&str>) -> Check {
    match digest.and_then(|d| d.strip_prefix("sha256:")) {
        Some(expected) if expected.eq_ignore_ascii_case(actual) => Check::new(CheckStatus::Passed, "與 GitHub 記錄的 SHA-256 相符"),
        Some(expected) => Check::new(CheckStatus::Failed, format!("SHA-256 不符：預期 {expected}")),
        None => Check::new(CheckStatus::NotAvailable, "GitHub 未提供此檔案的摘要"),
    }
}

/// Parse a `sha256sum`-style file and look up `file_name`.
pub fn find_in_sums(text: &str, file_name: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let mut it = line.split_whitespace();
        let hash = it.next()?;
        let name = it.next()?.trim_start_matches('*');
        let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
        (base == file_name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    })
}

pub fn check_sums_file(actual: &str, sums: Option<&str>, file_name: &str) -> Check {
    let Some(text) = sums else {
        return Check::new(CheckStatus::NotAvailable, "此版本未發布 SHA256SUMS 檔案");
    };
    match find_in_sums(text, file_name) {
        Some(expected) if expected.eq_ignore_ascii_case(actual) => Check::new(CheckStatus::Passed, "與 SHA256SUMS 相符"),
        Some(expected) => Check::new(CheckStatus::Failed, format!("與 SHA256SUMS 不符：預期 {expected}")),
        None => Check::new(CheckStatus::NotAvailable, "SHA256SUMS 未列出此檔案"),
    }
}

/// Minisign keys and signatures may be raw text or base64 of the text (Tauri updater format).
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

pub fn verify_minisign(public_key: &str, signature: &str, file: &Path) -> anyhow::Result<()> {
    let key_text = maybe_b64_text(public_key);
    let pk = if key_text.starts_with("untrusted comment:") {
        minisign_verify::PublicKey::decode(&key_text)?
    } else {
        minisign_verify::PublicKey::from_base64(&key_text)?
    };
    let sig = minisign_verify::Signature::decode(&maybe_b64_text(signature))?;
    let data = std::fs::read(file)?;
    pk.verify(&data, &sig, false)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sums_parsing() {
        let text = "3983f4e6cfa5a41e7d6f47c2f295d44e9a595f8b6773bcd293ee0dd369c69530  PikaraScienceStudio.exe\nabc  bad\n";
        assert_eq!(find_in_sums(text, "PikaraScienceStudio.exe").unwrap().len(), 64);
        assert!(find_in_sums(text, "bad").is_none());
        assert_eq!(check_github_digest("ab", Some("sha256:AB")).status, CheckStatus::Passed);
        assert_eq!(check_github_digest("ab", Some("sha256:cd")).status, CheckStatus::Failed);
    }
}
