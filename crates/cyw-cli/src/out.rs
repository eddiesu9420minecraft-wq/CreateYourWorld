//! Terminal output that behaves over SSH and in logs.
//!
//! * Human messages go to **stderr** as `[ HH:MM:SS ] LEVEL message`; results meant for programs go to
//!   **stdout** (`--json` prints exactly one JSON document there).
//! * Colors only when stderr is a terminal and `NO_COLOR` is not set (`FORCE_COLOR=1` forces them).
//! * Progress bars only when stderr is a terminal; otherwise (SSH without a TTY, CI, redirected logs) a plain
//!   line every 10 %, so remote logs never fill with redraw sequences.

use crate::i18n::Lang;
use std::io::{IsTerminal, Write};

pub struct Out {
    pub json: bool,
    pub quiet: bool,
    pub verbose: bool,
    pub yes: bool,
    pub color: bool,
    pub tty: bool,
    pub lang: Lang,
}

impl Out {
    pub fn new(json: bool, quiet: bool, verbose: bool, yes: bool, lang: Lang) -> Self {
        let tty = std::io::stderr().is_terminal();
        let no_color = std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty()) || std::env::var("TERM").is_ok_and(|t| t == "dumb");
        let force = std::env::var("FORCE_COLOR").is_ok_and(|v| v == "1");
        Self { json, quiet, verbose, yes, color: force || (tty && !no_color), tty, lang }
    }

    fn stamp() -> String {
        // local wall-clock time without pulling in a date crate: seconds since midnight UTC adjusted by the
        // offset the OS reports is not available portably, so print UTC with a Z (unambiguous in remote logs)
        let s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) % 86_400;
        format!("{:02}:{:02}:{:02}Z", s / 3600, (s / 60) % 60, s % 60)
    }

    fn line(&self, level: &str, color: &str, msg: &str) {
        if self.json || (self.quiet && level != "ERROR") {
            return;
        }
        let tag = if self.color { format!("\x1b[{color}m{level:<5}\x1b[0m") } else { format!("{level:<5}") };
        let _ = writeln!(std::io::stderr(), "[ {} ] {tag} {msg}", Self::stamp());
    }

    pub fn info(&self, msg: &str) {
        self.line("INFO", "34", msg);
    }
    pub fn ok(&self, msg: &str) {
        self.line("OK", "32", msg);
    }
    pub fn warn(&self, msg: &str) {
        self.line("WARN", "33", msg);
    }
    pub fn error(&self, msg: &str) {
        if self.json {
            return; // reported in the JSON document
        }
        self.line("ERROR", "31", msg);
    }
    pub fn debug(&self, msg: &str) {
        if self.verbose {
            self.line("DEBUG", "90", msg);
        }
    }

    /// Plain result text on stdout (tables, paths) — not shown with --json.
    pub fn print(&self, s: &str) {
        if !self.json {
            println!("{s}");
        }
    }

    /// Ask y/N on the terminal. Without a TTY (SSH command, CI) the answer is "no" unless --yes was given.
    pub fn confirm(&self, prompt: &str) -> Option<bool> {
        if self.yes {
            return Some(true);
        }
        if self.json || !std::io::stdin().is_terminal() || !self.tty {
            return None; // caller reports "add --yes"
        }
        eprint!("{prompt}");
        let _ = std::io::stderr().flush();
        let mut s = String::new();
        std::io::stdin().read_line(&mut s).ok()?;
        Some(matches!(s.trim().to_ascii_lowercase().as_str(), "y" | "yes" | "是" | "好"))
    }
}

pub fn fmt_bytes(n: u64) -> String {
    let f = n as f64;
    if f >= 1024.0 * 1024.0 * 1024.0 {
        format!("{:.2} GB", f / 1024f64.powi(3))
    } else if f >= 1024.0 * 1024.0 {
        format!("{:.1} MB", f / 1024f64.powi(2))
    } else if f >= 1024.0 {
        format!("{:.0} KB", f / 1024.0)
    } else {
        format!("{n} B")
    }
}
