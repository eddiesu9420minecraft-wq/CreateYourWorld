//! Safe archive extraction: rejects absolute paths, `..` traversal, escaping links,
//! and enforces size / entry-count limits against archive bombs.

use anyhow::{anyhow, bail, Context};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024 * 1024; // 32 GiB
const MAX_ENTRIES: usize = 200_000;

/// Join `rel` under `root`, refusing anything that could escape `root`.
fn safe_join(root: &Path, rel: &Path) -> anyhow::Result<PathBuf> {
    let mut out = root.to_path_buf();
    for c in rel.components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("封存檔含有不安全的路徑：{}", rel.display())
            }
        }
    }
    if out == root {
        bail!("封存檔含有空白路徑");
    }
    Ok(out)
}

/// A link target is acceptable only if, resolved from the link's directory, it stays inside root.
fn link_stays_inside(root: &Path, link_rel: &Path, target: &Path) -> bool {
    if target.is_absolute() {
        return false;
    }
    let mut depth: i64 = link_rel.components().count() as i64 - 1;
    for c in target.components() {
        match c {
            Component::Normal(_) => depth += 1,
            Component::ParentDir => depth -= 1,
            Component::CurDir => {}
            _ => return false,
        }
        if depth < 0 {
            return false;
        }
    }
    let _ = root;
    true
}

pub fn extract_zip(file: &Path, dest: &Path) -> anyhow::Result<()> {
    let f = fs::File::open(file)?;
    let mut zip = zip::ZipArchive::new(f).context("無法讀取 ZIP 檔")?;
    if zip.len() > MAX_ENTRIES {
        bail!("ZIP 檔項目過多");
    }
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let rel = entry.enclosed_name().ok_or_else(|| anyhow!("ZIP 檔含有不安全的路徑：{}", entry.name()))?;
        let out = safe_join(dest, &rel)?;
        if entry.is_dir() {
            fs::create_dir_all(&out)?;
            continue;
        }
        if entry.is_symlink() {
            bail!("ZIP 檔含有符號連結（已拒絕）：{}", entry.name());
        }
        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL_BYTES {
            bail!("ZIP 解壓縮後大小超過上限");
        }
        if let Some(p) = out.parent() {
            fs::create_dir_all(p)?;
        }
        let mut w = fs::File::create(&out)?;
        // `take` guards against headers that lie about the uncompressed size.
        let limit = entry.size() + 1;
        let copied = io::copy(&mut io::Read::take(&mut entry, limit), &mut w)?;
        if copied > entry.size() {
            bail!("ZIP 項目大小與標頭不符：{}", entry.name());
        }
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&out, fs::Permissions::from_mode(mode & 0o755))?;
        }
    }
    Ok(())
}

pub fn extract_tar_gz(file: &Path, dest: &Path) -> anyhow::Result<()> {
    let f = fs::File::open(file)?;
    let gz = flate2::read::GzDecoder::new(f);
    let mut ar = tar::Archive::new(gz);
    ar.set_preserve_permissions(false);
    ar.set_unpack_xattrs(false);
    let mut total: u64 = 0;
    for (count, entry) in ar.entries()?.enumerate() {
        if count >= MAX_ENTRIES {
            bail!("TAR 檔項目過多");
        }
        let mut entry = entry?;
        let rel = entry.path()?.into_owned();
        let out = match safe_join(dest, &rel) {
            Ok(p) => p,
            // The archive root entry "./" is harmless.
            Err(_) if rel.components().all(|c| matches!(c, Component::CurDir)) => continue,
            Err(e) => return Err(e),
        };
        let kind = entry.header().entry_type();
        if kind.is_hard_link() {
            bail!("TAR 檔含有硬連結（已拒絕）：{}", rel.display());
        }
        if kind.is_symlink() {
            let target = entry.link_name()?.ok_or_else(|| anyhow!("連結沒有目標"))?.into_owned();
            if !link_stays_inside(dest, &rel, &target) {
                bail!("TAR 檔含有指向外部的連結（已拒絕）：{}", rel.display());
            }
        } else if !(kind.is_file() || kind.is_dir() || kind.is_gnu_longname() || kind.is_pax_local_extensions()) {
            continue; // devices, fifos, etc. are skipped
        }
        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL_BYTES {
            bail!("TAR 解壓縮後大小超過上限");
        }
        if let Some(p) = out.parent() {
            fs::create_dir_all(p)?;
        }
        entry.unpack(&out)?;
        #[cfg(unix)]
        if kind.is_file() {
            use std::os::unix::fs::PermissionsExt;
            let mode = entry.header().mode().unwrap_or(0o644) & 0o755;
            fs::set_permissions(&out, fs::Permissions::from_mode(mode))?;
        }
    }
    Ok(())
}

pub fn extract_any(file: &Path, name: &str, dest: &Path) -> anyhow::Result<()> {
    let n = name.to_ascii_lowercase();
    if n.ends_with(".zip") {
        extract_zip(file, dest)
    } else if n.ends_with(".tar.gz") || n.ends_with(".tgz") {
        extract_tar_gz(file, dest)
    } else {
        bail!("不支援的封存格式：{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn join_rejects_traversal() {
        let root = Path::new("root");
        assert!(safe_join(root, Path::new("../x")).is_err());
        assert!(safe_join(root, Path::new("a/../../x")).is_err());
        assert!(safe_join(root, Path::new("a/b.txt")).is_ok());
    }
    #[test]
    fn links() {
        let root = Path::new("root");
        assert!(link_stays_inside(root, Path::new("App.app/Contents/x"), Path::new("../Frameworks/y")));
        assert!(!link_stays_inside(root, Path::new("x"), Path::new("../../etc/passwd")));
        assert!(!link_stays_inside(root, Path::new("x"), Path::new("/etc/passwd")));
    }
}
