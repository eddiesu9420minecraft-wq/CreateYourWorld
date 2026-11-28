//! `cyw` — the Create Your World command line.
//!
//! Native Rust, no GUI / WebView / Node.js. Shares `cyw-core` with the GUI: the same catalog, installed-app
//! database, settings, install folders, download verification (SHA-256, GitHub digest, minisign signature),
//! DoH-only networking, rollback and self-update. Safe to use over SSH: non-interactive, `--json`, no progress
//! animation without a TTY, a cross-process lock shared with the GUI.

mod args;
mod i18n;
mod out;
mod plugins;

use anyhow::{anyhow, bail};
use clap::{CommandFactory, Parser, Subcommand, ValueEnum};
use cyw_core::downloads::{JobInfo, JobState};
use cyw_core::host::{App, BoxFuture, Host};
use cyw_core::hub::{self, Core, SharedCore};
use cyw_core::launch::{self, Launched, Mode};
use cyw_core::settings::UpdateMode;
use i18n::{t, tf, Lang};
use out::{fmt_bytes, Out};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::sync::Arc;
use std::time::Duration;

/// Exit codes (documented in docs/cli.md).
pub mod code {
    pub const OK: i32 = 0;
    pub const ERROR: i32 = 1;
    pub const USAGE: i32 = 2;
    pub const NOT_FOUND: i32 = 3;
    pub const SECURITY: i32 = 4;
    pub const NETWORK: i32 = 5;
    pub const BUSY: i32 = 6;
}

#[derive(Parser, Debug)]
#[command(
    name = "cyw",
    version = cyw_core::VERSION,
    about = "Create Your World — Pikara software manager (CLI)",
    long_about = "Create Your World — Pikara software manager.\n\nShort forms: `cyw /run <app>` and `cyw -r <app>` = `cyw run <app>`; `cyw -m update [version]` = `cyw self update`; `cyw -m list software` = `cyw list software`; `cyw -m list V` = `cyw self versions`; `cyw -m <app> <plugin command>` manages that app's plugins.",
    disable_version_flag = true
)]
pub struct Cli {
    /// Print version
    #[arg(short = 'V', long = "version", action = clap::ArgAction::Version)]
    version: Option<bool>,
    /// Machine-readable output: exactly one JSON document on stdout
    #[arg(long, global = true)]
    json: bool,
    /// Only errors
    #[arg(short, long, global = true)]
    quiet: bool,
    /// More detail
    #[arg(short, long, global = true)]
    verbose: bool,
    /// Answer yes to confirmations (needed for non-interactive use, e.g. over SSH)
    #[arg(short, long, global = true)]
    yes: bool,
    /// Language: zh-TW, zh-CN, en (default: CYW_LANG or the system locale)
    #[arg(long, global = true)]
    lang: Option<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// List software, installed software or Create Your World versions
    List {
        #[arg(value_enum, default_value = "software")]
        what: ListWhat,
    },
    /// Download, verify and install software (or a specific version)
    Download {
        /// Package name (full product name, case-insensitive), e.g. PikaraScienceStudio, runX
        name: String,
        /// Version tag, e.g. v0.1.0-alpha
        #[arg(long = "version", short = 'r')]
        tag: Option<String>,
        /// Install a plugin (`--install` or `-- install`); see `cyw -m <app> list plugins`
        #[arg(long)]
        install: bool,
        /// Show what would happen without changing anything
        #[arg(long)]
        dry_run: bool,
    },
    /// Update one installed package, or all of them
    Update {
        name: Option<String>,
        #[arg(long)]
        all: bool,
        #[arg(long)]
        dry_run: bool,
    },
    /// Start installed software (`cyw /run` and `cyw -r` are the same). Arguments after `--` go to the program.
    Run {
        name: String,
        /// Wait for the program and return its exit code (default for CLI tools, or when arguments are given)
        #[arg(long, conflicts_with = "detach")]
        wait: bool,
        /// Start without waiting (default for GUI apps without arguments)
        #[arg(long)]
        detach: bool,
        #[arg(last = true, allow_hyphen_values = true)]
        args: Vec<OsString>,
    },
    /// Uninstall software (its own user data — projects, settings, databases — is kept)
    Remove { name: String },
    /// Switch back to the previous installed version
    Rollback { name: String },
    /// Put a command-line tool on the user PATH, or take it off
    Path {
        #[arg(value_enum)]
        action: PathAction,
        name: String,
    },
    /// Details of one package
    Info { name: String },
    /// Check the installation, data, network (DoH) and security setup
    Doctor,
    /// Create Your World itself
    #[command(name = "self")]
    SelfCmd {
        #[command(subcommand)]
        cmd: SelfCmd,
    },
    /// Plugins of a package (also `cyw -m <app> …`)
    Plugin {
        /// Target software (full product name)
        #[arg(long)]
        software: Option<String>,
        #[command(subcommand)]
        cmd: plugins::PluginCmd,
    },
    /// Print a shell completion script: powershell, bash or zsh
    Completions {
        #[arg(value_enum)]
        shell: CompShell,
    },
}

#[derive(Subcommand, Debug)]
enum SelfCmd {
    /// Update Create Your World (GUI and CLI) to the latest signed version
    Update { version: Option<String> },
    /// Current, latest and published versions of Create Your World
    Versions,
}

#[derive(ValueEnum, Clone, Copy, Debug)]
enum ListWhat {
    #[value(alias = "s")]
    Software,
    #[value(alias = "i")]
    Installed,
    #[value(alias = "v", alias = "V", alias = "version")]
    Versions,
}

#[derive(ValueEnum, Clone, Copy, Debug)]
enum PathAction {
    Add,
    Remove,
}

#[derive(ValueEnum, Clone, Copy, Debug)]
enum CompShell {
    Powershell,
    Bash,
    Zsh,
}

/// The CLI as the core's host: job events are read by polling, tasks run on tokio.
struct CliHost;

impl Host for CliHost {
    fn emit_json(&self, _topic: &str, _payload: Value) {}
    fn spawn(&self, task: BoxFuture) {
        tokio::spawn(task);
    }
}

fn main() {
    // helper modes used by self-update (no runtime, no network)
    let raw: Vec<OsString> = std::env::args_os().collect();
    match raw.get(1).and_then(|a| a.to_str()) {
        Some("--pikara-version") => {
            println!("{}", cyw_core::VERSION);
            std::process::exit(0);
        }
        Some("--pikara-apply-update") => {
            let code = raw.get(2).map(|p| cyw_core::selfupdate::run_helper(std::path::Path::new(p))).unwrap_or(2);
            std::process::exit(code);
        }
        _ => {}
    }
    if std::env::var_os("CYW_DEBUG_ARGS").is_some() {
        eprintln!("raw argv: {raw:?}");
    }
    let argv = args::normalize(raw);
    if std::env::var_os("CYW_DEBUG_ARGS").is_some() {
        eprintln!("normalized: {argv:?}");
    }
    let cli = match Cli::try_parse_from(&argv) {
        Ok(c) => c,
        Err(e) => {
            let code = if e.use_stderr() { code::USAGE } else { code::OK };
            let _ = e.print();
            std::process::exit(code);
        }
    };
    let lang = Lang::detect(cli.lang.as_deref());
    let out = Out::new(cli.json, cli.quiet, cli.verbose, cli.yes, lang);
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let result = rt.block_on(dispatch(cli.cmd, &out));
    let code = match result {
        Ok((code, value)) => {
            if out.json {
                println!("{}", serde_json::to_string_pretty(&with_ok(value, code == code::OK)).unwrap());
            }
            code
        }
        Err(e) => {
            let msg = format!("{e:#}");
            let code = classify(&msg);
            if out.json {
                println!("{}", serde_json::to_string_pretty(&json!({"ok": false, "code": code, "error": msg})).unwrap());
            } else {
                out.error(&msg);
            }
            code
        }
    };
    rt.shutdown_timeout(Duration::from_secs(2));
    if let Ok(p) = cyw_core::paths::Paths::resolve() {
        let _ = std::fs::remove_file(p.data.join("cli-jobs").join(format!("{}.json", std::process::id())));
    }
    std::process::exit(code);
}

fn with_ok(v: Value, ok: bool) -> Value {
    match v {
        Value::Object(mut m) => {
            m.entry("ok").or_insert(json!(ok));
            Value::Object(m)
        }
        other => json!({"ok": ok, "result": other}),
    }
}

/// Map an error to an exit code.
fn classify(msg: &str) -> i32 {
    let m = msg.to_lowercase();
    if ["簽章", "signature", "sha-256", "sha256", "降級", "downgrade", "replay", "不受信任", "安全"].iter().any(|k| m.contains(k)) {
        code::SECURITY
    } else if ["未知的產品", "尚未安裝", "找不到", "not installed", "unknown"].iter().any(|k| m.contains(k)) {
        code::NOT_FOUND
    } else if ["正在執行", "正在由另一個", "正在被另一個", "已有進行中"].iter().any(|k| m.contains(k)) {
        code::BUSY
    } else if ["連線", "dns", "doh", "network", "timed out", "逾時", "github api"].iter().any(|k| m.contains(k)) {
        code::NETWORK
    } else {
        code::ERROR
    }
}

async fn open_core(out: &Out) -> anyhow::Result<(SharedCore, App)> {
    let paths = cyw_core::paths::Paths::resolve()?;
    paths.ensure()?;
    out.debug(&format!("data: {}", paths.data.display()));
    let core: SharedCore = Arc::new(Core::new_cli(paths)?);
    core.load_state()?;
    // stale per-process job files of earlier `cyw` runs (crashed or killed)
    if let Ok(rd) = std::fs::read_dir(core.paths.data.join("cli-jobs")) {
        for e in rd.flatten() {
            let pid = e.path().file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<u32>().ok());
            if pid.is_some_and(|p| p != std::process::id() && !cyw_core::procs::pid_alive(p)) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok((core, Arc::new(CliHost)))
}

async fn dispatch(cmd: Cmd, out: &Out) -> anyhow::Result<(i32, Value)> {
    if let Cmd::Completions { shell } = cmd {
        let mut c = Cli::command();
        let sh = match shell {
            CompShell::Powershell => clap_complete::Shell::PowerShell,
            CompShell::Bash => clap_complete::Shell::Bash,
            CompShell::Zsh => clap_complete::Shell::Zsh,
        };
        clap_complete::generate(sh, &mut c, "cyw", &mut std::io::stdout());
        return Ok((code::OK, Value::Null));
    }
    let (core, app) = open_core(out).await?;
    match cmd {
        Cmd::List { what: ListWhat::Software } => list_software(&core, out).await,
        Cmd::List { what: ListWhat::Installed } => list_installed(&core, out),
        Cmd::List { what: ListWhat::Versions } => self_versions(&core, &app, out).await,
        Cmd::Download { name, tag, install, dry_run } => {
            if install || core.product(&name).is_err() && plugins::exists(&core, &name).await {
                return plugins::run(&core, &app, out, None, plugins::PluginCmd::Install { name, version: tag, dry_run }).await;
            }
            install_cmd(&core, &app, out, &name, tag, dry_run).await
        }
        Cmd::Update { name: Some(n), dry_run, .. } => update_one(&core, &app, out, &n, dry_run).await,
        Cmd::Update { name: None, all: true, dry_run } => update_all(&core, &app, out, dry_run).await,
        Cmd::Update { .. } => bail!("請指定軟體名稱，或使用 --all"),
        Cmd::Run { name, wait, detach, args } => run_cmd(&core, &app, out, &name, wait, detach, args).await,
        Cmd::Remove { name } => remove_cmd(&core, out, &name).await,
        Cmd::Rollback { name } => {
            let p = core.product(&name)?.id.clone();
            let tag = hub::rollback(&core, &p)?;
            out.ok(&tf(out.lang, "rolled_back", &[&p, &tag]));
            Ok((code::OK, json!({"product": p, "current": tag})))
        }
        Cmd::Path { action, name } => path_cmd(&core, out, action, &name),
        Cmd::Info { name } => info_cmd(&core, out, &name).await,
        Cmd::Doctor => doctor(&core, out).await,
        Cmd::SelfCmd { cmd: SelfCmd::Update { version } } => self_update(&core, &app, out, version).await,
        Cmd::SelfCmd { cmd: SelfCmd::Versions } => self_versions(&core, &app, out).await,
        Cmd::Plugin { software, cmd } => plugins::run(&core, &app, out, software, cmd).await,
        Cmd::Completions { .. } => unreachable!(),
    }
}

// ------------------------------------------------------------------------------------------------- list

async fn list_software(core: &SharedCore, out: &Out) -> anyhow::Result<(i32, Value)> {
    let views = hub::product_views(core, false).await;
    let mut rows = vec![];
    out.print(&format!("{:<22} {:<9} {:<16} {:<16} {}", "PACKAGE", "TYPE", "LATEST", "INSTALLED", "STATUS"));
    for v in &views {
        let kind = if v.cli.is_some() { "cli" } else { "app" };
        let latest = v.latest.as_ref().map(|r| r.tag.clone()).unwrap_or_else(|| "—".into());
        let inst = v.installed.as_ref().map(|a| a.current.clone()).unwrap_or_else(|| "—".into());
        let status = if v.update.is_some() { t(out.lang, "update_available") } else if v.installed.is_some() { t(out.lang, "installed") } else { v.status };
        out.print(&format!("{:<22} {:<9} {:<16} {:<16} {}", v.id, kind, latest, inst, status));
        if let Some(w) = &v.warning {
            out.warn(&format!("{}: {w}", v.id));
        }
        rows.push(json!({"package": v.id, "name": v.name, "category": v.category, "cli": v.cli, "channel": v.channel,
            "latest": v.latest.as_ref().map(|r| &r.tag), "installed": v.installed.as_ref().map(|a| &a.current),
            "update": v.update.as_ref().map(|r| &r.tag), "status": v.status, "signing": v.signing}));
    }
    Ok((code::OK, json!({"software": rows})))
}

fn list_installed(core: &SharedCore, out: &Out) -> anyhow::Result<(i32, Value)> {
    core.refresh_installed();
    let db = core.installed.lock().unwrap().clone();
    let mut rows = vec![];
    out.print(&format!("{:<22} {:<16} {:<24} {}", "PACKAGE", "CURRENT", "KEPT", "PATH"));
    for (id, a) in &db.apps {
        let kept: Vec<&str> = a.versions.iter().filter(|v| v.tag != a.current).map(|v| v.tag.as_str()).collect();
        let cur = a.current_version();
        out.print(&format!("{:<22} {:<16} {:<24} {}", id, a.current, if kept.is_empty() { "—".into() } else { kept.join(",") }, cur.map(|v| v.launch.display().to_string()).unwrap_or_default()));
        rows.push(json!({"package": id, "current": a.current, "versions": a.versions.iter().map(|v| &v.tag).collect::<Vec<_>>(),
            "onPath": a.on_path, "launch": cur.map(|v| &v.launch), "verification": cur.map(|v| &v.verification)}));
    }
    if db.apps.is_empty() {
        out.info(t(out.lang, "not_installed"));
    }
    Ok((code::OK, json!({"installed": rows})))
}

async fn info_cmd(core: &SharedCore, out: &Out, name: &str) -> anyhow::Result<(i32, Value)> {
    let p = core.product(name)?.clone();
    let v = hub::product_view(core, &p, false).await;
    out.print(&format!("{} — {}\n{}\nrepo: {}\nlatest: {}\ninstalled: {}", v.id, v.tagline, v.description, v.repo.clone().unwrap_or_default(),
        v.latest.as_ref().map(|r| r.tag.as_str()).unwrap_or("—"), v.installed.as_ref().map(|a| a.current.as_str()).unwrap_or("—")));
    Ok((code::OK, serde_json::to_value(&v)?))
}

// ------------------------------------------------------------------------------------------ install

/// Follow a download job until it ends, with a progress bar on a TTY and plain lines otherwise.
async fn wait_job(core: &SharedCore, out: &Out, id: u64, label: &str) -> anyhow::Result<JobInfo> {
    let bar = (out.tty && !out.quiet && !out.json).then(|| {
        let b = indicatif::ProgressBar::new(0);
        b.set_style(
            indicatif::ProgressStyle::with_template("{msg} [{bar:30.yellow/dim}] {bytes}/{total_bytes} {bytes_per_sec} ETA {eta}")
                .unwrap()
                .progress_chars("=> "),
        );
        b.set_message(label.to_string());
        b
    });
    let mut last_decile = -1i64;
    let mut last_state = None;
    loop {
        let info = core.jobs.list().into_iter().find(|j| j.id == id).ok_or_else(|| anyhow!("job {id} vanished"))?;
        if last_state != Some(info.state) {
            match info.state {
                JobState::Verifying => {
                    if let Some(b) = &bar {
                        b.set_message(t(out.lang, "verifying"));
                    } else {
                        out.info(t(out.lang, "verifying"));
                    }
                }
                JobState::Installing => {
                    if let Some(b) = &bar {
                        b.set_message(t(out.lang, "installing"));
                    } else {
                        out.info(t(out.lang, "installing"));
                    }
                }
                _ => {}
            }
            last_state = Some(info.state);
        }
        if let Some(b) = &bar {
            b.set_length(info.total.max(info.downloaded));
            b.set_position(info.downloaded);
        } else if info.total > 0 && !out.quiet && !out.json {
            let d = (info.downloaded * 10 / info.total) as i64;
            if d != last_decile && info.state == JobState::Downloading {
                last_decile = d;
                let eta = if info.speed > 0 { format!(", ETA {}s", (info.total - info.downloaded) / info.speed.max(1)) } else { String::new() };
                out.info(&format!("{} {} {}% ({}/{}, {}/s{eta})", t(out.lang, "downloading"), label, d * 10, fmt_bytes(info.downloaded), fmt_bytes(info.total), fmt_bytes(info.speed)));
            }
        }
        match info.state {
            JobState::Completed | JobState::Failed | JobState::Canceled => {
                if let Some(b) = &bar {
                    b.finish_and_clear();
                }
                return Ok(info);
            }
            _ => tokio::time::sleep(Duration::from_millis(120)).await,
        }
    }
}

fn job_json(j: &JobInfo) -> Value {
    json!({"job": j.id, "package": j.product_id, "version": j.tag, "state": j.state, "asset": j.asset.name, "bytes": j.total,
        "verification": j.verification, "error": j.error})
}

async fn install_cmd(core: &SharedCore, app: &App, out: &Out, name: &str, tag: Option<String>, dry_run: bool) -> anyhow::Result<(i32, Value)> {
    let p = core.product(name)?.clone();
    if dry_run {
        let (_, rel, asset) = hub::resolve_release(core, &p.id, tag.as_deref()).await?;
        out.info(&format!("{} {} ← {} ({}) {}", p.id, rel.tag_name, asset.name, fmt_bytes(asset.size), t(out.lang, "dry_run")));
        return Ok((code::OK, json!({"dryRun": true, "package": p.id, "version": rel.tag_name, "asset": asset.name, "size": asset.size, "signatureRequired": p.minisign_public_key.is_some()})));
    }
    if let (Some(a), None) = (core.installed_app(&p.id), &tag) {
        let v = hub::product_view(core, &p, false).await;
        if v.update.is_none() {
            out.ok(&format!("{} {} — {}", p.id, a.current, t(out.lang, "up_to_date")));
            return Ok((code::OK, json!({"package": p.id, "current": a.current, "changed": false})));
        }
    }
    let r = hub::request_install(core, app, &p.id, tag, false).await?;
    if let Some(t2) = r.switched_to {
        out.ok(&format!("{} {} — {}", p.id, t2, t(out.lang, "switched")));
        return Ok((code::OK, json!({"package": p.id, "current": t2, "switched": true})));
    }
    let id = r.job_id.ok_or_else(|| anyhow!("no job"))?;
    let j = wait_job(core, out, id, &p.id).await?;
    if j.state != JobState::Completed {
        bail!("{}", j.error.clone().unwrap_or_else(|| format!("{:?}", j.state)));
    }
    let v = j.verification.as_ref();
    out.ok(&format!("{} {} — {} (SHA-256 {}, GitHub digest {}, signature {})", p.id, j.tag, t(out.lang, "done_install"),
        v.map(|r| short(&r.sha256)).unwrap_or_default(), v.map(|r| status(&r.github_digest.status)).unwrap_or_default(),
        v.map(|r| status(&r.signature.status)).unwrap_or_default()));
    Ok((code::OK, job_json(&j)))
}

fn short(s: &str) -> String {
    s.chars().take(12).collect()
}

fn status<T: serde::Serialize>(s: &T) -> String {
    serde_json::to_value(s).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

async fn update_one(core: &SharedCore, app: &App, out: &Out, name: &str, dry_run: bool) -> anyhow::Result<(i32, Value)> {
    let p = core.product(name)?.clone();
    if core.installed_app(&p.id).is_none() {
        bail!("{}", tf(out.lang, "hint_download", &[&p.id, &p.id]));
    }
    install_cmd(core, app, out, &p.id, None, dry_run).await
}

async fn update_all(core: &SharedCore, app: &App, out: &Out, dry_run: bool) -> anyhow::Result<(i32, Value)> {
    let views = hub::product_views(core, true).await;
    let todo: Vec<_> = views.iter().filter(|v| v.update.is_some() && v.installed.is_some()).collect();
    if todo.is_empty() {
        out.ok(t(out.lang, "nothing_to_update"));
        return Ok((code::OK, json!({"updated": []})));
    }
    let mut results = vec![];
    let mut worst = code::OK;
    for v in todo {
        out.info(&format!("{} {} → {}", v.id, v.installed.as_ref().unwrap().current, v.update.as_ref().unwrap().tag));
        match install_cmd(core, app, out, &v.id, None, dry_run).await {
            Ok((_, j)) => results.push(j),
            Err(e) => {
                let msg = format!("{e:#}");
                out.error(&format!("{}: {msg}", v.id));
                worst = classify(&msg);
                results.push(json!({"package": v.id, "error": msg}));
            }
        }
    }
    Ok((worst, json!({"updated": results})))
}

// ---------------------------------------------------------------------------------------------- run

async fn run_cmd(core: &SharedCore, app: &App, out: &Out, name: &str, wait: bool, detach: bool, args: Vec<OsString>) -> anyhow::Result<(i32, Value)> {
    let p = core.product(name)?.clone();
    if core.installed_app(&p.id).is_none() {
        match out.confirm(&tf(out.lang, "offer_download", &[&p.id])) {
            Some(true) => {
                install_cmd(core, app, out, &p.id, None, false).await?;
            }
            _ => {
                out.warn(&tf(out.lang, "hint_download", &[&p.id, &p.id]));
                return Ok((code::NOT_FOUND, json!({"package": p.id, "installed": false, "hint": format!("cyw download {}", p.id)})));
            }
        }
    }
    let mode = if wait { Mode::Wait } else if detach { Mode::Detach } else { Mode::Auto };
    match launch::launch(core, &p.id, &args, mode)? {
        Launched::Detached { pid, program } => {
            out.ok(&tf(out.lang, "started", &[&p.id, &pid.to_string()]));
            Ok((code::OK, json!({"package": p.id, "pid": pid, "program": program, "detached": true})))
        }
        Launched::Exited { code: c, program } => Ok((c, json!({"package": p.id, "exitCode": c, "program": program}))),
    }
}

async fn remove_cmd(core: &SharedCore, out: &Out, name: &str) -> anyhow::Result<(i32, Value)> {
    let p = core.product(name)?.id.clone();
    if core.installed_app(&p).is_none() {
        bail!("{p} {}", t(out.lang, "not_installed"));
    }
    match out.confirm(&tf(out.lang, "confirm_remove", &[&p])) {
        Some(true) => {}
        Some(false) => {
            out.info(t(out.lang, "cancelled"));
            return Ok((code::OK, json!({"package": p, "removed": false})));
        }
        None => {
            out.error(t(out.lang, "need_yes"));
            return Ok((code::USAGE, json!({"package": p, "removed": false, "error": "confirmation required: --yes"})));
        }
    }
    hub::ensure_not_busy(core, &p)?;
    let c = core.clone();
    let pid = p.clone();
    tokio::task::spawn_blocking(move || hub::uninstall(&c, &pid)).await??;
    out.ok(t(out.lang, "removed"));
    Ok((code::OK, json!({"package": p, "removed": true, "userDataKept": true})))
}

fn path_cmd(core: &SharedCore, out: &Out, action: PathAction, name: &str) -> anyhow::Result<(i32, Value)> {
    let p = core.product(name)?.clone();
    let bin = cyw_core::cli_path::binary_name(&p).ok_or_else(|| anyhow!("{} 不是命令列工具", p.id))?;
    let on = matches!(action, PathAction::Add);
    let problem = hub::set_on_path(core, &p.id, on)?;
    if let Some(pr) = &problem {
        bail!("{pr}");
    }
    out.ok(&tf(out.lang, if on { "path_added" } else { "path_removed" }, &[&bin]));
    Ok((code::OK, json!({"package": p.id, "onPath": on, "bin": cyw_core::cli_path::bin_dir(&core.paths)})))
}

// ------------------------------------------------------------------------------------- self update

fn gui_running() -> bool {
    let Ok(dir) = cyw_core::selfupdate::install_target() else { return false };
    let dir = std::path::PathBuf::from(dir.to_string_lossy().to_lowercase());
    // any process from the install folder other than cyw itself (the GUI holds files the installer replaces)
    cyw_core::procs::processes_with_paths().iter().any(|(pid, path)| {
        *pid != std::process::id() && std::path::PathBuf::from(path.to_string_lossy().to_lowercase()).starts_with(&dir)
            && !path.file_stem().is_some_and(|s| s.eq_ignore_ascii_case("cyw"))
    })
}

async fn self_update(core: &SharedCore, app: &App, out: &Out, version: Option<String>) -> anyhow::Result<(i32, Value)> {
    cyw_core::selfupdate::check(core, app, UpdateMode::Notify).await;
    let st = core.selfupdate.status();
    match st.state.as_str() {
        "up-to-date" => {
            if let Some(v) = &version {
                if v.trim_start_matches('v') != cyw_core::VERSION {
                    bail!("只能更新到已簽署的 update.json 所列的最新版本（目前最新：{}）；不支援安裝其他版本或降級", cyw_core::VERSION);
                }
            }
            out.ok(&tf(out.lang, "self_latest", &[cyw_core::VERSION]));
            return Ok((code::OK, json!({"current": cyw_core::VERSION, "latest": st.latest, "changed": false})));
        }
        "available" => {}
        "unsupported" => bail!("{}", st.unsupported_reason.clone().unwrap_or_else(|| "unsupported".into())),
        _ => bail!("{}", st.error.clone().unwrap_or_else(|| st.state.clone())),
    }
    let latest = st.latest.clone().unwrap_or_default();
    if let Some(v) = &version {
        if v.trim_start_matches('v') != latest.trim_start_matches('v') {
            bail!("只能更新到已簽署的 update.json 所列的最新版本 {latest}；指定的 {v} 不是（不支援降級或未簽署的版本）");
        }
    }
    if gui_running() {
        return Ok((code::BUSY, json!({"error": t(out.lang, "gui_running")}))).inspect(|_| out.error(t(out.lang, "gui_running")));
    }
    let id = cyw_core::selfupdate::download(core, app).await?;
    let j = wait_job(core, out, id, "Create Your World").await?;
    if j.state != JobState::Completed || core.selfupdate.staged().is_none() {
        bail!("{}", j.error.clone().or(core.selfupdate.status().error).unwrap_or_else(|| "self-update failed".into()));
    }
    cyw_core::selfupdate::spawn_apply(core, false)?;
    let log = core.paths.data.join("self-update").join("helper.log");
    out.ok(&tf(out.lang, "self_ready", &[&latest, &log.display().to_string()]));
    Ok((code::OK, json!({"current": cyw_core::VERSION, "installing": latest, "log": log})))
}

async fn self_versions(core: &SharedCore, app: &App, out: &Out) -> anyhow::Result<(i32, Value)> {
    cyw_core::selfupdate::check(core, app, UpdateMode::Manual).await;
    let st = core.selfupdate.status();
    let rel = core.github.releases("eddiesu9420minecraft-wq/CreateYourWorld", false).await;
    out.print(&format!("current  {}\nlatest   {} ({})", cyw_core::VERSION, st.latest.clone().unwrap_or_else(|| cyw_core::VERSION.into()), st.state));
    let mut tags = vec![];
    if let Ok(r) = &rel {
        for x in &r.releases {
            out.print(&format!("  {:<16} {}", x.tag_name, x.published_at.clone().unwrap_or_default()));
            tags.push(json!({"tag": x.tag_name, "publishedAt": x.published_at, "prerelease": x.prerelease}));
        }
    }
    Ok((code::OK, json!({"current": cyw_core::VERSION, "latest": st.latest, "state": st.state, "error": st.error, "releases": tags})))
}

// ------------------------------------------------------------------------------------------ doctor

async fn doctor(core: &SharedCore, out: &Out) -> anyhow::Result<(i32, Value)> {
    let mut checks: Vec<Value> = vec![];
    let mut add = |name: &str, ok: bool, detail: String| {
        if ok {
            out.ok(&format!("{name}: {detail}"));
        } else {
            out.error(&format!("{name}: {detail}"));
        }
        checks.push(json!({"check": name, "ok": ok, "detail": detail}));
    };
    add("version", true, format!("cyw {} ({} {})", cyw_core::VERSION, std::env::consts::OS, std::env::consts::ARCH));
    add("data", core.paths.data.is_dir(), core.paths.data.display().to_string());
    let lock = cyw_core::lock::state(&core.paths).map(|_| ());
    add("state lock", lock.is_ok(), lock.err().map(|e| e.to_string()).unwrap_or_else(|| "acquired and released".into()));
    let uniq = cyw_core::ids::check_unique(&core.catalog);
    add("catalog", uniq.is_ok(), uniq.err().unwrap_or_else(|| format!("{} packages, unique full names", core.catalog.len())));
    core.refresh_installed();
    let db = core.installed.lock().unwrap().clone();
    let missing: Vec<String> = db.apps.values().filter_map(|a| a.current_version().filter(|v| !v.launch.exists()).map(|_| a.product_id.clone())).collect();
    add("installed", missing.is_empty(), if missing.is_empty() { format!("{} package(s), all present", db.apps.len()) } else { format!("missing files: {}", missing.join(", ")) });
    add("signing key", cyw_core::selfupdate::pubkey_ok(), "Pikara release key 13216449EEB947A5 (compiled in)".into());
    let dns = core.resolver.lookup("api.github.com").await;
    add("DoH (no system DNS)", dns.is_ok(), match &dns {
        Ok(l) => format!("api.github.com → {} via {}", l.addrs.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(", "), l.provider),
        Err(e) => e.to_string(),
    });
    let api = core.github.releases("eddiesu9420minecraft-wq/CreateYourWorld", true).await;
    let rate = core.github.rate_info();
    add("GitHub API", api.is_ok(), match &api {
        Ok(r) => format!("{} release(s); rate {}/{}", r.releases.len(), rate.remaining.map(|x| x.to_string()).unwrap_or("?".into()), rate.limit.map(|x| x.to_string()).unwrap_or("?".into())),
        Err(e) => e.to_string(),
    });
    let bin = cyw_core::cli_path::bin_dir(&core.paths);
    let path_env = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let cyw_on_path = exe_dir.as_ref().is_some_and(|d| path_env.iter().any(|p| p == d));
    add("cyw on PATH", true, if cyw_on_path { "yes".into() } else { format!("no (run from {})", exe_dir.map(|d| d.display().to_string()).unwrap_or_default()) });
    add("tools bin", true, format!("{} ({})", bin.display(), if cyw_core::cli_path::registered(&core.paths) { "on user PATH" } else { "not on PATH" }));
    add("admin rights", true, "not required (user-scope install, PATH and data)".into());
    let failed = checks.iter().filter(|c| c["ok"] == false).count();
    if failed == 0 {
        out.ok(t(out.lang, "doctor_ok"));
    } else {
        out.error(&tf(out.lang, "doctor_fail", &[&failed.to_string()]));
    }
    Ok((if failed == 0 { code::OK } else { code::ERROR }, json!({"checks": checks})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clap_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn exit_code_classification() {
        assert_eq!(classify("數位簽章驗證失敗"), code::SECURITY);
        assert_eq!(classify("SHA-256 mismatch"), code::SECURITY);
        assert_eq!(classify("未知的產品：studio"), code::NOT_FOUND);
        assert_eq!(classify("PikaraScienceStudio 正在執行；請先關閉"), code::BUSY);
        assert_eq!(classify("GitHub API 連線失敗"), code::NETWORK);
    }
}
