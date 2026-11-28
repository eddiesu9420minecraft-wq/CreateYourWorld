use serde::{de::DeserializeOwned, Serialize};
use std::ffi::OsStr;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Load a JSON file, falling back to `T::default()` when it does not exist.
/// A file that exists but cannot be parsed is moved aside (never silently overwritten).
pub fn load_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[cyw] {} is corrupt ({e}); moving aside", path.display());
                let _ = std::fs::rename(path, path.with_extension(format!("corrupt-{}", now_secs())));
                T::default()
            }
        },
        Err(_) => T::default(),
    }
}

/// Atomic write: write to a temp file next to the target, then rename over it.
pub fn save_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // unique temp name: two processes never share a temp file
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let data = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path)
}

/// A `Command` that never flashes a console window on Windows.
pub fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Make a string safe to use as a single path component.
pub fn sanitize_component(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    let trimmed = out.trim_matches('.');
    if trimmed.is_empty() { "_".to_string() } else { trimmed.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sanitize_blocks_traversal() {
        assert_eq!(sanitize_component("../../etc"), "_.._etc");
        assert_eq!(sanitize_component("v0.3.1"), "v0.3.1");
        assert_eq!(sanitize_component(".."), "_");
    }
}
