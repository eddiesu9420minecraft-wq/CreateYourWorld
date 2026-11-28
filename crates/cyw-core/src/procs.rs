//! Process inspection: is an installed app running? (We never force-close user apps.)

use std::path::Path;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

fn snapshot() -> System {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_exe(UpdateKind::Always));
    sys
}

/// True if any process's executable lives under `dir`.
pub fn running_under(dir: &Path) -> bool {
    let sys = snapshot();
    let canon = dunce(dir);
    let found = sys.processes().values().any(|p| p.exe().is_some_and(|exe| dunce(exe).starts_with(&canon)));
    found
}

pub fn pid_alive(pid: u32) -> bool {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true, ProcessRefreshKind::nothing());
    sys.process(Pid::from_u32(pid)).is_some()
}

pub fn wait_pid_exit(pid: u32, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if !pid_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    !pid_alive(pid)
}

/// Case/prefix-normalised path for comparisons (Windows paths may differ in case or `\\?\`).
fn dunce(p: &Path) -> std::path::PathBuf {
    let s = p.to_string_lossy().replace("\\\\?\\", "");
    let s = if cfg!(windows) { s.to_lowercase() } else { s };
    std::path::PathBuf::from(s)
}

/// (pid, executable) of every process whose executable path is known.
pub fn processes_with_paths() -> Vec<(u32, std::path::PathBuf)> {
    let sys = snapshot();
    sys.processes().iter().filter_map(|(pid, p)| p.exe().map(|e| (pid.as_u32(), dunce(e)))).collect()
}
