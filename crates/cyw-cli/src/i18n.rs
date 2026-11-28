//! Messages in Traditional Chinese, Simplified Chinese and English.
//! Language: `--lang`, else `CYW_LANG`, else the OS locale (`LANG` / `LC_ALL`, Windows user locale), else zh-TW.
//! Errors coming from the shared core are in Traditional Chinese.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    ZhTw,
    ZhCn,
    En,
}

impl Lang {
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.to_ascii_lowercase().replace('_', "-");
        if s.starts_with("zh-cn") || s.starts_with("zh-sg") || s.starts_with("zh-hans") {
            Some(Lang::ZhCn)
        } else if s.starts_with("zh") {
            Some(Lang::ZhTw)
        } else if s.starts_with("en") {
            Some(Lang::En)
        } else {
            None
        }
    }

    pub fn detect(flag: Option<&str>) -> Self {
        flag.and_then(Self::parse)
            .or_else(|| std::env::var("CYW_LANG").ok().and_then(|v| Self::parse(&v)))
            .or_else(|| ["LC_ALL", "LC_MESSAGES", "LANG"].iter().find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty() && v != "C" && v != "POSIX").and_then(|v| Self::parse(&v))))
            .or_else(|| sys_locale::get_locale().and_then(|l| Self::parse(&l)))
            .unwrap_or(Lang::ZhTw)
    }
}

/// `t(lang, key)` — every key has all three languages.
pub fn t(lang: Lang, key: &str) -> &'static str {
    let (tw, cn, en) = match key {
        "not_installed" => ("尚未安裝", "尚未安装", "not installed"),
        "installed" => ("已安裝", "已安装", "installed"),
        "up_to_date" => ("已是最新版本", "已是最新版本", "already up to date"),
        "update_available" => ("可更新", "可更新", "update available"),
        "downloading" => ("下載中", "下载中", "Downloading"),
        "verifying" => ("驗證 SHA-256 與數位簽章", "验证 SHA-256 与数字签名", "Verifying SHA-256 and signature"),
        "installing" => ("安裝中", "安装中", "Installing"),
        "done_install" => ("安裝完成", "安装完成", "Installed"),
        "switched" => ("已切換到保留的版本（不需下載）", "已切换到保留的版本（无需下载）", "Switched to a kept version (no download)"),
        "removed" => ("已解除安裝；應用程式自己的使用者資料（專案、設定、資料庫）沒有被刪除", "已卸载；应用程序自己的用户数据（项目、设置、数据库）没有被删除", "Removed; the app's own user data (projects, settings, databases) was kept"),
        "confirm_remove" => ("要解除安裝 {} 嗎？使用者資料會保留。[y/N] ", "要卸载 {} 吗？用户数据会保留。[y/N] ", "Remove {}? User data is kept. [y/N] "),
        "need_yes" => ("沒有互動式終端機：請加上 --yes 確認", "没有交互式终端：请加上 --yes 确认", "No interactive terminal: add --yes to confirm"),
        "cancelled" => ("已取消", "已取消", "Cancelled"),
        "offer_download" => ("{} 尚未安裝。要現在下載並安裝嗎？[y/N] ", "{} 尚未安装。要现在下载并安装吗？[y/N] ", "{} is not installed. Download and install it now? [y/N] "),
        "hint_download" => ("{} 尚未安裝；請執行：cyw download {}", "{} 尚未安装；请运行：cyw download {}", "{} is not installed; run: cyw download {}"),
        "started" => ("已啟動 {}（PID {}）", "已启动 {}（PID {}）", "Started {} (PID {})"),
        "nothing_to_update" => ("沒有可更新的軟體", "没有可更新的软件", "Nothing to update"),
        "self_ready" => ("Create Your World {} 已下載並通過驗證；本指令結束後由更新程式安裝（失敗會自動還原）。紀錄：{}", "Create Your World {} 已下载并通过验证；本命令结束后由更新程序安装（失败会自动还原）。日志：{}", "Create Your World {} is downloaded and verified; it is installed after this command exits (restored automatically on failure). Log: {}"),
        "self_latest" => ("Create Your World 已是最新版本（{}）", "Create Your World 已是最新版本（{}）", "Create Your World is up to date ({})"),
        "gui_running" => ("Create Your World 視窗正在執行；請先關閉再更新", "Create Your World 窗口正在运行；请先关闭再更新", "The Create Your World window is running; close it before updating"),
        "doctor_ok" => ("全部檢查通過", "全部检查通过", "All checks passed"),
        "doctor_fail" => ("有 {} 項檢查未通過", "有 {} 项检查未通过", "{} check(s) failed"),
        "path_added" => ("已把 {} 加入使用者 PATH；請開新的終端機", "已把 {} 加入用户 PATH；请打开新的终端", "Added {} to the user PATH; open a new terminal"),
        "path_removed" => ("已從使用者 PATH 移除 {}", "已从用户 PATH 移除 {}", "Removed {} from the user PATH"),
        "rolled_back" => ("{} 已回復到 {}", "{} 已回滚到 {}", "{} rolled back to {}"),
        "dry_run" => ("（--dry-run：沒有做任何變更）", "（--dry-run：没有做任何更改）", "(--dry-run: nothing was changed)"),
        _ => ("?", "?", "?"),
    };
    match lang {
        Lang::ZhTw => tw,
        Lang::ZhCn => cn,
        Lang::En => en,
    }
}

/// `t` with `{}` placeholders filled in order.
pub fn tf(lang: Lang, key: &str, args: &[&str]) -> String {
    let mut s = t(lang, key).to_string();
    for a in args {
        if let Some(i) = s.find("{}") {
            s.replace_range(i..i + 2, a);
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_parsing() {
        assert_eq!(Lang::parse("zh_TW.UTF-8"), Some(Lang::ZhTw));
        assert_eq!(Lang::parse("zh-Hant-TW"), Some(Lang::ZhTw));
        assert_eq!(Lang::parse("zh_CN.UTF-8"), Some(Lang::ZhCn));
        assert_eq!(Lang::parse("zh-Hans"), Some(Lang::ZhCn));
        assert_eq!(Lang::parse("en_US"), Some(Lang::En));
        assert_eq!(Lang::parse("fr_FR"), None);
    }

    #[test]
    fn placeholders() {
        assert_eq!(tf(Lang::En, "started", &["runX", "42"]), "Started runX (PID 42)");
    }
}
