//! `cyw plugin …` / `cyw -m <App> …` — plugin commands on top of `cyw_core::plugins`.

use crate::out::{fmt_bytes, Out};
use crate::code;
use anyhow::{anyhow, bail};
use clap::Subcommand;
use cyw_core::host::App;
use cyw_core::hub::SharedCore;
use cyw_core::plugins::{self, Index};
use serde_json::{json, Value};

#[derive(Subcommand, Debug)]
pub enum PluginCmd {
    /// List available plugins, or installed ones
    List {
        #[arg(default_value = "plugins")]
        what: String,
    },
    /// Install a plugin (and its dependencies) — `download <plugin> --install` is the same
    Install {
        name: String,
        #[arg(long = "version")]
        version: Option<String>,
        #[arg(long)]
        dry_run: bool,
    },
    /// Remove a plugin
    Remove { name: String },
    /// Update one plugin, or all
    Update {
        name: Option<String>,
        #[arg(long)]
        all: bool,
        #[arg(long)]
        dry_run: bool,
    },
    Enable { name: String },
    Disable { name: String },
    /// Switch back to the previous installed version
    Rollback { name: String },
}

/// Does any software publish a plugin with this name? (decides `cyw download <name>` routing)
pub async fn exists(core: &SharedCore, name: &str) -> bool {
    !plugins::owners(core, name).await.is_empty()
}

async fn index_for(core: &SharedCore, software: &str) -> anyhow::Result<(String, Index)> {
    let p = core.product(software)?.clone();
    let ix = plugins::fetch_index(core, &p).await?.ok_or_else(|| anyhow!("{} 沒有發布外掛索引（目前不支援外掛）", p.id))?;
    Ok((p.id, ix))
}

/// Resolve the target software: given with -m / --software, else the single software publishing the plugin.
async fn target(core: &SharedCore, software: Option<String>, plugin: &str) -> anyhow::Result<(String, Index)> {
    if let Some(s) = software {
        return index_for(core, &s).await;
    }
    let mut owners = plugins::owners(core, plugin).await;
    match owners.len() {
        0 => bail!("找不到名為 {plugin} 的外掛"),
        1 => Ok(owners.remove(0)),
        _ => bail!(
            "多個軟體都有名為 {plugin} 的外掛（{}）；請用 -m <軟體> 指定，例如：cyw -m {} download {plugin} -- install",
            owners.iter().map(|(s, _)| s.as_str()).collect::<Vec<_>>().join("、"),
            owners[0].0
        ),
    }
}

pub async fn run(core: &SharedCore, _app: &App, out: &Out, software: Option<String>, cmd: PluginCmd) -> anyhow::Result<(i32, Value)> {
    match cmd {
        PluginCmd::List { what } if what == "installed" => {
            let sw = software.ok_or_else(|| anyhow!("請用 -m <軟體> 指定軟體"))?;
            let id = core.product(&sw)?.id.clone();
            let db = plugins::load_db(core);
            let m = db.software.get(&id).cloned().unwrap_or_default();
            out.print(&format!("{:<24} {:<10} {:<8} {}", "PLUGIN", "VERSION", "ENABLED", "PERMISSIONS"));
            for p in m.values() {
                out.print(&format!("{:<24} {:<10} {:<8} {}", p.id, p.current, p.enabled, p.permissions.join(",")));
            }
            Ok((code::OK, json!({"software": id, "installed": m.values().collect::<Vec<_>>()})))
        }
        PluginCmd::List { .. } => {
            let sw = software.ok_or_else(|| anyhow!("請用 -m <軟體> 指定軟體"))?;
            let (id, ix) = index_for(core, &sw).await?;
            let db = plugins::load_db(core);
            let inst = db.software.get(&id).cloned().unwrap_or_default();
            out.print(&format!("{:<24} {:<10} {:<10} {}", "PLUGIN", "LATEST", "INSTALLED", "DESCRIPTION"));
            let mut rows = vec![];
            for e in &ix.plugins {
                let latest = e.versions.iter().map(|v| v.version.clone()).max_by(|a, b| semver::Version::parse(a).ok().cmp(&semver::Version::parse(b).ok())).unwrap_or_default();
                let i = inst.values().find(|p| p.id.eq_ignore_ascii_case(&e.id)).map(|p| p.current.clone());
                out.print(&format!("{:<24} {:<10} {:<10} {}", e.id, latest, i.clone().unwrap_or_else(|| "—".into()), e.description));
                rows.push(json!({"id": e.id, "name": e.name, "latest": latest, "installed": i, "description": e.description,
                    "versions": e.versions.iter().map(|v| json!({"version": v.version, "requires": v.requires, "dependencies": v.dependencies, "conflicts": v.conflicts, "permissions": v.permissions, "size": v.size})).collect::<Vec<_>>()}));
            }
            Ok((code::OK, json!({"software": id, "plugins": rows})))
        }
        PluginCmd::Install { name, version, dry_run } => install(core, out, software, &name, version.as_deref(), dry_run).await,
        PluginCmd::Update { name: Some(n), dry_run, .. } => install(core, out, software, &n, None, dry_run).await,
        PluginCmd::Update { name: None, all: true, dry_run } => {
            let sw = software.ok_or_else(|| anyhow!("請用 -m <軟體> 指定軟體"))?;
            let id = core.product(&sw)?.id.clone();
            let ids: Vec<String> = plugins::load_db(core).software.get(&id).map(|m| m.values().map(|p| p.id.clone()).collect()).unwrap_or_default();
            let mut res = vec![];
            for p in ids {
                res.push(install(core, out, Some(id.clone()), &p, None, dry_run).await.map(|r| r.1).unwrap_or_else(|e| json!({"id": p, "error": format!("{e:#}")})));
            }
            Ok((code::OK, json!({"software": id, "updated": res})))
        }
        PluginCmd::Update { .. } => bail!("請指定外掛名稱，或使用 --all"),
        PluginCmd::Remove { name } => {
            let (sw, ix) = target(core, software, &name).await?;
            let removed = plugins::remove(core, &sw, &name, Some(&ix))?;
            out.ok(&format!("{sw}: 已移除外掛 {removed}"));
            Ok((code::OK, json!({"software": sw, "removed": removed})))
        }
        PluginCmd::Enable { name } => toggle(core, out, software, &name, true),
        PluginCmd::Disable { name } => toggle(core, out, software, &name, false),
        PluginCmd::Rollback { name } => {
            let sw = core.product(&software.ok_or_else(|| anyhow!("請用 -m <軟體> 指定軟體"))?)?.id.clone();
            let v = plugins::rollback(core, &sw, &name)?;
            out.ok(&format!("{sw}: {name} 已回復到 {v}"));
            Ok((code::OK, json!({"software": sw, "plugin": name, "current": v})))
        }
    }
}

fn toggle(core: &SharedCore, out: &Out, software: Option<String>, name: &str, on: bool) -> anyhow::Result<(i32, Value)> {
    let sw = core.product(&software.ok_or_else(|| anyhow!("請用 -m <軟體> 指定軟體"))?)?.id.clone();
    plugins::set_enabled(core, &sw, name, on)?;
    out.ok(&format!("{sw}: {name} {}", if on { "已啟用" } else { "已停用" }));
    Ok((code::OK, json!({"software": sw, "plugin": name, "enabled": on})))
}

async fn install(core: &SharedCore, out: &Out, software: Option<String>, name: &str, version: Option<&str>, dry_run: bool) -> anyhow::Result<(i32, Value)> {
    let (sw, ix) = target(core, software, name).await?;
    let db = plugins::load_db(core);
    let hv = plugins::host_version(core, &sw);
    let steps = plugins::plan(&ix, &db, hv.as_ref(), name, version)?;
    let todo: Vec<_> = steps.iter().filter(|s| !s.present).collect();
    for s in &steps {
        out.info(&format!("{sw}: {} {} {} — {} — 權限：{}", if s.present { "✓" } else { "+" }, s.id, s.version, fmt_bytes(s.size), if s.permissions.is_empty() { "無".into() } else { s.permissions.join("、") }));
        if !s.scripts.is_empty() {
            out.warn(&format!("{} 宣告了安裝腳本（{}）；Create Your World 不會執行第三方腳本", s.id, s.scripts.join("、")));
        }
    }
    let plan_json = json!({"software": sw, "steps": steps, "dryRun": dry_run});
    if dry_run {
        out.info("（--dry-run：沒有做任何變更）");
        return Ok((code::OK, plan_json));
    }
    if todo.is_empty() {
        out.ok(&format!("{sw}: {name} 已是最新"));
        return Ok((code::OK, plan_json));
    }
    let extra: Vec<String> = todo.iter().flat_map(|s| s.permissions.iter().filter(|p| *p != "files:plugin").cloned()).collect();
    if !extra.is_empty() {
        match out.confirm(&format!("外掛需要以下權限：{}。要繼續嗎？[y/N] ", extra.join("、"))) {
            Some(true) => {}
            Some(false) => return Ok((code::OK, json!({"software": sw, "installed": false, "reason": "declined"}))),
            None => {
                out.error("外掛需要額外權限；非互動模式請加上 --yes 表示同意");
                return Ok((code::USAGE, json!({"software": sw, "installed": false, "error": "permissions need --yes", "permissions": extra})));
            }
        }
    }
    let mut done = vec![];
    for s in &todo {
        out.info(&format!("{sw}: 下載並驗證 {} {}", s.id, s.version));
        if let Err(e) = plugins::install_step(core, &sw, s).await {
            // steps installed so far stay on disk but are not recorded as current: nothing changes for the app
            for d in &done {
                let d: &&plugins::Step = d;
                let _ = std::fs::remove_dir_all(plugins::plugin_root(core, &sw).join(&d.id).join(&d.version));
            }
            bail!("{} {} 安裝失敗，已還原：{e:#}", s.id, s.version);
        }
        done.push(*s);
    }
    plugins::record(core, &sw, &steps)?;
    out.ok(&format!("{sw}: 已安裝 {}", steps.iter().map(|s| format!("{} {}", s.id, s.version)).collect::<Vec<_>>().join("、")));
    Ok((code::OK, plan_json))
}
