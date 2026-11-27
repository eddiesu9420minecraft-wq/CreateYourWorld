use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecureError {
    /// All DoH providers failed (network down, blocked, or bad answers).
    Resolution(String),
    /// The name does not exist (authoritative NXDOMAIN from DoH).
    NxDomain(String),
    /// URL is not https or its host is not on the allow-list.
    UrlRejected(String),
    Network(String),
    BadSignature(String),
    Sha256Mismatch { expected: String, actual: String },
    Manifest(String),
    /// Manifest offers a version lower than the one installed.
    Downgrade { offered: String, current: String },
    /// Manifest is older than one already accepted (replay of a stale signed file).
    Replay(String),
    Io(String),
}

impl fmt::Display for SecureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Resolution(m) => write!(f, "安全 DNS 解析失敗：{m}"),
            Self::NxDomain(h) => write!(f, "網域不存在：{h}"),
            Self::UrlRejected(m) => write!(f, "拒絕不安全或不在允許清單中的網址：{m}"),
            Self::Network(m) => write!(f, "網路錯誤：{m}"),
            Self::BadSignature(m) => write!(f, "數位簽章驗證失敗：{m}"),
            Self::Sha256Mismatch { expected, actual } => write!(f, "SHA-256 不符（預期 {expected}，實際 {actual}）"),
            Self::Manifest(m) => write!(f, "更新資訊無效：{m}"),
            Self::Downgrade { offered, current } => write!(f, "拒絕降級：更新資訊提供 {offered}，但目前已是 {current}"),
            Self::Replay(m) => write!(f, "拒絕過期的更新資訊（可能是重放攻擊）：{m}"),
            Self::Io(m) => write!(f, "檔案錯誤：{m}"),
        }
    }
}

impl std::error::Error for SecureError {}

impl From<std::io::Error> for SecureError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}
