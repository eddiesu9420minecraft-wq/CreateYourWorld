//! Integrity (SHA-256) and authenticity (minisign signature) checks.

use serde::{Deserialize, Serialize};
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
    pikara_secure::artifact::sha256_file(path).map_err(|e| std::io::Error::other(e.to_string()))
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

/// Streaming SHA-256 + minisign check via Pikara Secure Network (file never loaded into RAM).
pub fn verify_minisign(public_key: &str, signature: &str, file: &Path, expected_sha256: &str) -> anyhow::Result<()> {
    pikara_secure::artifact::verify_file(file, expected_sha256, signature, public_key)?;
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
