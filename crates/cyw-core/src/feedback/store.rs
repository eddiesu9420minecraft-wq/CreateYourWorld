//! Feedback session storage. The session token is encrypted for the current Windows user with DPAPI;
//! on macOS / Linux the file is readable by the owner only (0600). The GitHub token itself never reaches the
//! client — this is the Feedback backend's own session.

use super::client::Session;
use anyhow::Result;
use std::path::Path;

pub fn load(path: &Path) -> Option<Session> {
    let raw = std::fs::read(path).ok()?;
    let plain = unprotect(&raw)?;
    serde_json::from_slice(&plain).ok()
}

pub fn save(path: &Path, s: &Session) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let data = protect(&serde_json::to_vec(s)?)?;
    let tmp = path.with_extension("tmp");
    write_private(&tmp, &data)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn clear(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(unix)]
fn write_private(p: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(p)?;
    f.write_all(data)?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(p: &Path, data: &[u8]) -> Result<()> {
    std::fs::write(p, data)?;
    Ok(())
}

#[cfg(windows)]
fn protect(plain: &[u8]) -> Result<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: valid input blob for the call's duration; the output buffer is copied and freed with LocalFree.
    unsafe {
        if CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) == 0 {
            anyhow::bail!("DPAPI 加密失敗：{}", std::io::Error::last_os_error());
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        Ok(v)
    }
}

#[cfg(windows)]
fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: as in `protect`.
    unsafe {
        if CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) == 0 {
            return None;
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        Some(v)
    }
}

#[cfg(not(windows))]
fn protect(plain: &[u8]) -> Result<Vec<u8>> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    Some(data.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_not_plaintext_on_windows() {
        let dir = std::env::temp_dir().join(format!("cyw-fb-store-{}", std::process::id()));
        let p = dir.join("session.bin");
        let s = Session { base: "http://127.0.0.1:1".into(), token: "secret-session-token-value".into(), expires_at: 1, user: serde_json::json!({"login": "x"}) };
        save(&p, &s).unwrap();
        let raw = std::fs::read(&p).unwrap();
        if cfg!(windows) {
            assert!(!raw.windows(12).any(|w| w == b"secret-sessi"), "token must not be stored in plain text");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(load(&p).unwrap().token, s.token);
        std::fs::write(&p, b"garbage").unwrap();
        assert!(load(&p).is_none());
        clear(&p);
        assert!(load(&p).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
