//! Integration tests: the real `cyw` binary, an isolated data folder (`PIKARA_CYW_DATA_DIR`) and a throwaway
//! PATH registry key (`PIKARA_CYW_ENV_KEY`), so the user's real installation is never touched.
//! Network tests (GitHub downloads) run when `CYW_NET_TESTS=1` (set in CI).

use std::path::PathBuf;
use std::process::{Command, Output};

const CYW: &str = env!("CARGO_BIN_EXE_cyw");

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("cyw-it-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(CYW)
            .args(args)
            .env("PIKARA_CYW_DATA_DIR", &self.dir)
            .env("PIKARA_CYW_ENV_KEY", format!(r"Software\PikaraCYWTest\It-{}", std::process::id()))
            .env("NO_COLOR", "1")
            .env("CYW_LANG", "en")
            .current_dir(&self.dir)
            .output()
            .unwrap()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn s(b: &[u8]) -> String {
    String::from_utf8_lossy(b).to_string()
}

fn json(o: &Output) -> serde_json::Value {
    serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("not JSON ({e}):\n{}", s(&o.stdout)))
}

#[test]
fn version_and_help() {
    let e = Env::new("ver");
    let o = e.run(&["-V"]);
    assert!(o.status.success());
    assert_eq!(s(&o.stdout).trim(), format!("cyw {}", env!("CARGO_PKG_VERSION")));
    let h = e.run(&["-h"]);
    assert!(h.status.success());
    for cmd in ["download", "run", "update", "doctor", "plugin", "completions"] {
        assert!(s(&h.stdout).contains(cmd), "help mentions {cmd}");
    }
    // the helper's version probe used by self-update
    assert_eq!(s(&e.run(&["--pikara-version"]).stdout).trim(), env!("CARGO_PKG_VERSION"));
}

#[test]
fn generic_aliases_are_rejected_with_exit_3() {
    let e = Env::new("alias");
    for alias in ["studio", "pikarastudio", "pss"] {
        let o = e.run(&["--json", "download", alias]);
        assert_eq!(o.status.code(), Some(3), "{alias}: {}", s(&o.stdout));
        let j = json(&o);
        assert_eq!(j["ok"], false);
        assert!(j["error"].as_str().unwrap().contains(alias));
    }
}

#[test]
fn run_of_an_uninstalled_package_suggests_download_without_prompting() {
    let e = Env::new("run");
    for form in [&["--json", "run", "PikaraScienceStudio"][..], &["--json", "/run", "pikarasciencestudio"], &["--json", "-r", "PIKARASCIENCESTUDIO"]] {
        let o = e.run(form);
        assert_eq!(o.status.code(), Some(3), "{form:?}");
        let j = json(&o);
        assert_eq!(j["installed"], false);
        assert_eq!(j["hint"], "cyw download PikaraScienceStudio");
    }
}

#[test]
fn list_installed_is_empty_and_json() {
    let e = Env::new("list");
    let o = e.run(&["--json", "list", "installed"]);
    assert!(o.status.success());
    assert_eq!(json(&o)["installed"], serde_json::json!([]));
    let o = e.run(&["--json", "-m", "list", "installed"]);
    assert!(o.status.success());
}

#[test]
fn remove_needs_yes_without_a_terminal() {
    let e = Env::new("remove");
    let o = e.run(&["remove", "runX"]);
    assert_eq!(o.status.code(), Some(3), "not installed → 3: {}", s(&o.stderr));
}

#[test]
fn completions_for_three_shells() {
    let e = Env::new("comp");
    for sh in ["powershell", "bash", "zsh"] {
        let o = e.run(&["completions", sh]);
        assert!(o.status.success(), "{sh}");
        let out = s(&o.stdout);
        assert!(out.len() > 1000 && out.contains("cyw") && out.contains("download"), "{sh}");
    }
}

#[test]
fn usage_errors_exit_2() {
    let e = Env::new("usage");
    assert_eq!(e.run(&["no-such-command"]).status.code(), Some(2));
    assert_eq!(e.run(&["run"]).status.code(), Some(2));
}

#[test]
fn languages() {
    let e = Env::new("lang");
    let en = e.run(&["--lang", "en", "list", "installed"]);
    assert!(s(&en.stderr).contains("not installed"));
    let cn = e.run(&["--lang", "zh-CN", "list", "installed"]);
    assert!(s(&cn.stderr).contains("尚未安装"));
    let tw = e.run(&["--lang", "zh-TW", "list", "installed"]);
    assert!(s(&tw.stderr).contains("尚未安裝"));
}

#[test]
fn no_progress_animation_without_a_terminal() {
    // output of a non-TTY run must be plain lines: no carriage returns or ANSI escapes (SSH / CI logs)
    let e = Env::new("tty");
    let o = e.run(&["list", "installed"]);
    let all = s(&o.stderr) + &s(&o.stdout);
    assert!(!all.contains('\r') && !all.contains('\x1b'), "{all:?}");
}

fn net() -> bool {
    std::env::var("CYW_NET_TESTS").is_ok_and(|v| v == "1")
}

#[test]
fn network_install_run_exit_code_plugins_remove() {
    if !net() {
        eprintln!("skipped: set CYW_NET_TESTS=1");
        return;
    }
    let e = Env::new("net");
    // install (download + SHA-256 + GitHub digest + signature)
    let o = e.run(&["--json", "download", "runx"]);
    assert!(o.status.success(), "{}\n{}", s(&o.stdout), s(&o.stderr));
    let j = json(&o);
    assert_eq!(j["verification"]["signature"]["status"], "passed");
    // CLI tool: inherited stdio and exit code passthrough
    let v = e.run(&["run", "runX", "--", "--version"]);
    assert!(v.status.success());
    assert!(s(&v.stdout).contains("runxc "));
    let bad = e.run(&["/run", "runX", "--", "--no-such-flag"]);
    assert_eq!(bad.status.code(), Some(2), "runxc's own exit code");
    // arguments are never a shell string
    let inj = e.run(&["run", "runX", "--", "x.rux & echo INJECTED"]);
    assert!(!s(&inj.stdout).contains("INJECTED"));
    // plugins: dependency resolution, shared DB, dependents protected
    let p = e.run(&["--json", "-m", "runX", "download", "runX-Tutorial", "--", "install"]);
    assert!(p.status.success(), "{}", s(&p.stderr));
    let ids: Vec<String> = json(&p)["steps"].as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, vec!["runX-Examples", "runX-Tutorial"]);
    let down = e.run(&["-m", "runX", "download", "runX-Examples", "--version", "1.0.0", "--install"]);
    assert_eq!(down.status.code(), Some(1), "must not break runX-Tutorial");
    // remove keeps user data and needs --yes without a terminal
    assert_eq!(e.run(&["remove", "runX"]).status.code(), Some(2));
    assert!(e.run(&["--yes", "remove", "runX"]).status.success());
    assert_eq!(json(&e.run(&["--json", "list", "installed"]))["installed"], serde_json::json!([]));
}
