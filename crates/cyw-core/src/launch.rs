//! Starting installed software — shared by the GUI ("開啟") and the CLI (`cyw run` / `cyw /run` / `cyw -r`).
//!
//! * Never goes through a shell: the program and each argument are passed separately (no string
//!   concatenation, so arguments can't inject commands). Script launch targets (`.bat` / `.cmd`) are refused
//!   because Windows would hand them to `cmd.exe`.
//! * Command-line tools (and any program started with `wait`) inherit stdin / stdout / stderr and their exit
//!   code is returned unchanged.
//! * GUI applications are started detached: the caller (terminal, SSH session) is not blocked.

use crate::hub::Core;
use anyhow::{anyhow, bail, Context};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// CLI tools wait, GUI apps detach; GUI apps given arguments also wait (headless / CLI modes).
    Auto,
    Wait,
    Detach,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Launched {
    Detached { pid: u32, program: PathBuf },
    Exited { code: i32, program: PathBuf },
}

/// Is this product a command-line tool (no window)?
pub fn is_cli(core: &Core, product_id: &str) -> bool {
    core.product(product_id).map(|p| p.cli.as_ref().is_some_and(|c| c.applies_here())).unwrap_or(false)
}

fn refuse_scripts(path: &Path) -> anyhow::Result<()> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if ["bat", "cmd", "ps1", "vbs", "sh"].contains(&ext.as_str()) {
        bail!("拒絕啟動腳本檔：{}（只能啟動原生執行檔）", path.display());
    }
    Ok(())
}

/// The executable inside a macOS `.app` bundle (for running it attached to the terminal).
fn bundle_executable(app: &Path) -> Option<PathBuf> {
    let dir = app.join("Contents").join("MacOS");
    std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path()).find(|p| p.is_file())
}

/// Start the current version of `product_id`.
pub fn launch(core: &Core, product_id: &str, args: &[OsString], mode: Mode) -> anyhow::Result<Launched> {
    let p = core.product(product_id)?.clone();
    let app = core.installed_app(&p.id).ok_or_else(|| anyhow!("{} 尚未安裝", p.id))?;
    let v = app.current_version().ok_or_else(|| anyhow!("安裝資料損毀：找不到 {} 的目前版本", p.id))?;
    if !v.launch.exists() {
        bail!("找不到程式檔：{}", v.launch.display());
    }
    refuse_scripts(&v.launch)?;
    let wait = match mode {
        Mode::Wait => true,
        Mode::Detach => false,
        Mode::Auto => p.cli.as_ref().is_some_and(|c| c.applies_here()) || !args.is_empty(),
    };
    let is_bundle = v.launch.extension().is_some_and(|x| x == "app");
    if wait {
        let program = if is_bundle { bundle_executable(&v.launch).ok_or_else(|| anyhow!("{} 內找不到執行檔", v.launch.display()))? } else { v.launch.clone() };
        let status = Command::new(&program)
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .with_context(|| format!("無法啟動 {}", program.display()))?;
        return Ok(Launched::Exited { code: exit_code(&status), program });
    }
    #[cfg(target_os = "macos")]
    if is_bundle {
        // `open` hands the bundle to LaunchServices; arguments still go as a list
        let child = Command::new("open").arg("-n").arg("-a").arg(&v.launch).arg("--args").args(args).spawn().context("無法啟動應用程式")?;
        return Ok(Launched::Detached { pid: child.id(), program: v.launch.clone() });
    }
    let mut cmd = Command::new(&v.launch);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(dir) = v.launch.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // detached from the caller's console: closing the terminal / SSH session doesn't close the app
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let child = cmd.spawn().with_context(|| format!("無法啟動 {}", v.launch.display()))?;
    Ok(Launched::Detached { pid: child.id(), program: v.launch.clone() })
}

fn exit_code(s: &std::process::ExitStatus) -> i32 {
    if let Some(c) = s.code() {
        return c;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = s.signal() {
            return 128 + sig;
        }
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_are_refused() {
        assert!(refuse_scripts(Path::new(r"C:\x\evil.bat")).is_err());
        assert!(refuse_scripts(Path::new(r"C:\x\run.CMD")).is_err());
        assert!(refuse_scripts(Path::new(r"C:\x\app.exe")).is_ok());
        assert!(refuse_scripts(Path::new("/opt/x/runxc")).is_ok());
    }
}
