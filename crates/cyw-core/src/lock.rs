//! Cross-process lock for CYW's shared state (installed.json, settings.json, plugin DB).
//!
//! The GUI and any number of `cyw` processes (local or over SSH) may run at once. Every read-modify-write of a
//! shared file happens while holding an exclusive OS file lock on `<data>/.state.lock`; files are replaced with
//! an atomic rename, so lock-free readers always see a complete file. The OS releases the lock if a process dies.
//! Long operations (download, install) take a second, per-product lock so two processes never install the same
//! product at the same time.

use crate::paths::Paths;
use fs4::fs_std::FileExt;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub struct FileLock {
    file: File,
    path: PathBuf,
}

impl FileLock {
    /// Wait up to `timeout` for the exclusive lock.
    pub fn acquire(path: &Path, timeout: Duration) -> anyhow::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path)?;
        let start = Instant::now();
        loop {
            match FileExt::try_lock_exclusive(&file) {
                Ok(true) => return Ok(Self { file, path: path.to_path_buf() }),
                Ok(false) => {}
                Err(e) if e.kind() != std::io::ErrorKind::WouldBlock => return Err(e.into()),
                Err(_) => {}
            }
            if start.elapsed() >= timeout {
                anyhow::bail!("{} 正在被另一個 Create Your World 程序使用（等候 {} 秒後放棄）", path.display(), timeout.as_secs());
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }

    /// Try once; `None` when another process holds it.
    pub fn try_acquire(path: &Path) -> anyhow::Result<Option<Self>> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path)?;
        Ok(match FileExt::try_lock_exclusive(&file) {
            Ok(true) => Some(Self { file, path: path.to_path_buf() }),
            _ => None,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

/// Short critical sections on the shared state files.
pub fn state(paths: &Paths) -> anyhow::Result<FileLock> {
    FileLock::acquire(&paths.data.join(".state.lock"), Duration::from_secs(30))
}

/// Held for a whole download + install of one product (per product id, case-insensitive).
pub fn product(paths: &Paths, product_id: &str) -> anyhow::Result<Option<FileLock>> {
    let name = crate::util::sanitize_component(&product_id.to_ascii_lowercase());
    FileLock::try_acquire(&paths.data.join("locks").join(format!("{name}.lock")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_holder_waits_then_fails_then_succeeds_after_release() {
        let p = std::env::temp_dir().join(format!("cyw-lock-{}", std::process::id())).join(".state.lock");
        let a = FileLock::acquire(&p, Duration::from_secs(1)).unwrap();
        assert!(FileLock::try_acquire(&p).unwrap().is_none(), "held lock must block a second holder");
        let t = Instant::now();
        assert!(FileLock::acquire(&p, Duration::from_millis(200)).is_err());
        assert!(t.elapsed() >= Duration::from_millis(200));
        drop(a);
        assert!(FileLock::try_acquire(&p).unwrap().is_some());
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }
}
