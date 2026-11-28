//! Automatic redaction of secrets and personal data before anything is shown in the upload preview.
//!
//! Same rules as the server (`services/feedback/src/redact.ts`, contract in `docs/feedback/API.md`), plus
//! two client-only rules that need local knowledge: the local user name(s) and the machine's host name.
//! Replacements are `[REDACTED:<kind>]`; home folders become `<home>`.

use regex::{Captures, Regex};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct Redacted {
    pub text: String,
    /// kind → number of replacements
    pub counts: BTreeMap<String, u32>,
}

impl Redacted {
    pub fn total(&self) -> u32 {
        self.counts.values().sum()
    }
}

/// Local identity values to scrub (user names, host names). Built from the environment by [`Redactor::local`].
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    users: Vec<Regex>,
    hosts: Vec<Regex>,
}

fn tag(kind: &str) -> String {
    format!("[REDACTED:{kind}]")
}

struct Rules {
    pem: Regex,
    minisign: Regex,
    url_creds: Regex,
    tokens: Vec<Regex>,
    auth_header: Regex,
    kv: Regex,
    email: Regex,
    sensitive_path: Regex,
    home_win: Regex,
    home_unix: Regex,
    mac: Regex,
    ipv6: Regex,
    ipv4: Regex,
}

fn rules() -> &'static Rules {
    static R: OnceLock<Rules> = OnceLock::new();
    R.get_or_init(|| Rules {
        pem: Regex::new(r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|\z)").unwrap(),
        minisign: Regex::new(r"(?i)untrusted comment:[^\n]*secret key[^\n]*\r?\n[A-Za-z0-9+/=]{20,}").unwrap(),
        url_creds: Regex::new(r"\b([A-Za-z][A-Za-z0-9+.-]*://)[^\s/:@]+:[^\s/@]+@").unwrap(),
        tokens: [
            r"\bgh[pousr]_[A-Za-z0-9]{20,}\b",
            r"\bgithub_pat_[A-Za-z0-9_]{20,}\b",
            r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
            r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b",
            r"\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b",
            r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b",
            r"\bAIza[0-9A-Za-z_-]{30,}\b",
            r"\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b",
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect(),
        auth_header: Regex::new(r#"(?i)(\b(?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)?\s*|\bbearer\s+)([A-Za-z0-9._~+/=:-]{8,})"#).unwrap(),
        kv: Regex::new(r#"(?i)(\b[a-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)[a-z0-9_.-]*["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&"']+)"#).unwrap(),
        email: Regex::new(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b").unwrap(),
        sensitive_path: Regex::new(r#"(?i)(?:[A-Za-z]:|~|<home>)?(?:[\\/][^\s\\/"'<>|*?]+)*?[\\/](?:\.ssh|\.gnupg|\.aws|\.kube|\.docker[\\/]config\.json|keychains|credentials)\b(?:[\\/][^\s"'<>|]*)?"#).unwrap(),
        home_win: Regex::new(r#"(?i)\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s"'<>|:*?]+"#).unwrap(),
        home_unix: Regex::new(r#"(?:^|[\s"'=(\[:,])(/(?:Users|home)/(?:\[REDACTED:user\]|[^/\s"'<>|:]+))"#).unwrap(),
        mac: Regex::new(r"\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b").unwrap(),
        ipv6: Regex::new(r"[0-9A-Fa-f:]{2,39}(?:%[0-9A-Za-z]+)?").unwrap(),
        ipv4: Regex::new(r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b").unwrap(),
    })
}

fn bump(counts: &mut BTreeMap<String, u32>, kind: &str, n: u32) {
    if n > 0 {
        *counts.entry(kind.to_string()).or_default() += n;
    }
}

/// Replace every match of `re` with `[REDACTED:kind]`.
fn simple(text: String, re: &Regex, kind: &str, counts: &mut BTreeMap<String, u32>) -> String {
    let mut n = 0;
    let out = re.replace_all(&text, |_: &Captures| {
        n += 1;
        tag(kind)
    });
    let out = out.into_owned();
    bump(counts, kind, n);
    out
}

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_alphanumeric() || c == '_')
}

impl Redactor {
    /// Redactor that knows the current user name(s) and host name.
    pub fn local() -> Self {
        let mut users: Vec<String> = ["USERNAME", "USER", "LOGNAME"].iter().filter_map(|k| std::env::var(k).ok()).collect();
        if let Some(h) = dirs::home_dir().and_then(|h| h.file_name().map(|n| n.to_string_lossy().into_owned())) {
            users.push(h);
        }
        let mut hosts: Vec<String> = ["COMPUTERNAME", "HOSTNAME"].iter().filter_map(|k| std::env::var(k).ok()).collect();
        if let Some(h) = sysinfo::System::host_name() {
            hosts.push(h);
        }
        Self::with_identity(&users, &hosts)
    }

    /// Redactor for explicit identity values (tests; also used by `local`).
    pub fn with_identity(users: &[String], hosts: &[String]) -> Self {
        fn compile(values: &[String]) -> Vec<Regex> {
            let mut v: Vec<String> = values.iter().map(|s| s.trim().to_string()).filter(|s| s.chars().count() >= 3).collect();
            // generic account names would wreck ordinary text
            v.retain(|s| !matches!(s.to_ascii_lowercase().as_str(), "user" | "admin" | "root" | "runner" | "localhost" | "default" | "public"));
            v.sort_by_key(|s| std::cmp::Reverse(s.len()));
            v.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
            v.iter().filter_map(|s| Regex::new(&format!("(?i){}", regex::escape(s))).ok()).collect()
        }
        Self { users: compile(users), hosts: compile(hosts) }
    }

    /// Redactor without local identity (same rules as the server).
    pub fn generic() -> Self {
        Self::default()
    }

    pub fn redact(&self, input: &str) -> Redacted {
        let r = rules();
        let mut counts = BTreeMap::new();
        let mut t = input.to_string();

        t = simple(t, &r.pem, "private_key", &mut counts);
        t = simple(t, &r.minisign, "private_key", &mut counts);

        let mut n = 0;
        t = r.url_creds.replace_all(&t, |c: &Captures| {
            n += 1;
            format!("{}{}@", &c[1], tag("url_credentials"))
        }).into_owned();
        bump(&mut counts, "url_credentials", n);

        for re in &r.tokens {
            t = simple(t, re, "token", &mut counts);
        }

        let mut n = 0;
        t = r.auth_header.replace_all(&t, |c: &Captures| {
            if c[2].starts_with("[REDACTED") {
                return c[0].to_string();
            }
            n += 1;
            format!("{}{}", &c[1], tag("token"))
        }).into_owned();
        bump(&mut counts, "token", n);

        let mut n = 0;
        t = r.kv.replace_all(&t, |c: &Captures| {
            let v = c[2].trim_matches(|ch| ch == '"' || ch == '\'');
            if v.is_empty() || v.starts_with("[REDACTED") || v.starts_with('<') {
                return c[0].to_string();
            }
            n += 1;
            format!("{}{}", &c[1], tag("token"))
        }).into_owned();
        bump(&mut counts, "token", n);

        t = simple(t, &r.email, "email", &mut counts);

        // before the path rules, so a spaced user folder (`C:\Users\Bob Smith`) is covered whole
        // host names first: they often contain the user name (`ALICE-PC`)
        for re in &self.hosts {
            t = replace_words(t, re, "host", &mut counts);
        }
        for re in &self.users {
            t = replace_words(t, re, "user", &mut counts);
        }

        t = simple(t, &r.sensitive_path, "path", &mut counts);
        let mut n = 0;
        t = r.home_win.replace_all(&t, |_: &Captures| {
            n += 1;
            "<home>".to_string()
        }).into_owned();
        t = r.home_unix.replace_all(&t, |c: &Captures| {
            n += 1;
            let whole = &c[0];
            let lead = &whole[..whole.len() - c[1].len()];
            format!("{lead}<home>")
        }).into_owned();
        bump(&mut counts, "path", n);

        t = simple(t, &r.mac, "mac", &mut counts);
        t = redact_ipv6(t, &r.ipv6, &mut counts);
        t = redact_ipv4(t, &r.ipv4, &mut counts);

        Redacted { text: t, counts }
    }
}

/// Whole-word (not inside a longer identifier) case-insensitive replacement.
fn replace_words(text: String, re: &Regex, kind: &str, counts: &mut BTreeMap<String, u32>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut n = 0;
    for m in re.find_iter(&text) {
        let before = text[..m.start()].chars().next_back();
        let after = text[m.end()..].chars().next();
        if is_word(before) || is_word(after) {
            continue;
        }
        out.push_str(&text[last..m.start()]);
        out.push_str(&tag(kind));
        last = m.end();
        n += 1;
    }
    out.push_str(&text[last..]);
    bump(counts, kind, n);
    out
}

fn redact_ipv4(text: String, re: &Regex, counts: &mut BTreeMap<String, u32>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut n = 0;
    for c in re.captures_iter(&text) {
        let m = c.get(0).unwrap();
        let octets: Vec<u32> = (1..=4).map(|i| c[i].parse().unwrap_or(999)).collect();
        if octets.iter().any(|&o| o > 255) {
            continue;
        }
        let bytes = text.as_bytes();
        let before = m.start().checked_sub(1).map(|i| bytes[i]);
        let after = bytes.get(m.end()).copied();
        let after2 = bytes.get(m.end() + 1).copied();
        // 1.2.3.4.5 (longer dotted numbers), v1.2.3.4 (versions) and loopback / unspecified addresses are left alone
        if matches!(before, Some(b'.') | Some(b'v') | Some(b'V')) || (after == Some(b'.') && after2.is_some_and(|b| b.is_ascii_digit())) {
            continue;
        }
        if octets[0] == 127 || octets == [0, 0, 0, 0] {
            continue;
        }
        out.push_str(&text[last..m.start()]);
        out.push_str(&tag("ip"));
        last = m.end();
        n += 1;
    }
    out.push_str(&text[last..]);
    bump(counts, "ip", n);
    out
}

fn redact_ipv6(text: String, re: &Regex, counts: &mut BTreeMap<String, u32>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut n = 0;
    for m in re.find_iter(&text) {
        let s = m.as_str();
        let addr = s.split('%').next().unwrap_or(s);
        if addr.matches(':').count() < 2 {
            continue;
        }
        let Ok(ip) = addr.parse::<std::net::Ipv6Addr>() else { continue };
        if ip.is_loopback() || ip.is_unspecified() {
            continue;
        }
        let bytes = text.as_bytes();
        let before = m.start().checked_sub(1).map(|i| bytes[i] as char);
        let after = bytes.get(m.end()).map(|b| *b as char);
        if is_word(before) || is_word(after) || before == Some('.') {
            continue;
        }
        // short forms like `ab::cd` are far more often code (`a::b`) than addresses
        if addr.len() < 6 {
            continue;
        }
        out.push_str(&text[last..m.start()]);
        out.push_str(&tag("ip"));
        last = m.end();
        n += 1;
    }
    out.push_str(&text[last..]);
    bump(counts, "ip", n);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(s: &str) -> Redacted {
        Redactor::generic().redact(s)
    }

    #[test]
    fn private_keys() {
        let pem = "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nafter";
        let r = g(pem);
        assert_eq!(r.text, "before\n[REDACTED:private_key]\nafter");
        let rsa = g("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n(truncated log");
        assert_eq!(rsa.text, "[REDACTED:private_key]");
        let ms = g("untrusted comment: minisign encrypted secret key\nRWRTY0IyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
        assert_eq!(ms.text, "[REDACTED:private_key]\n");
        // public keys stay
        let pubkey = "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----";
        assert_eq!(g(pubkey).text, pubkey);
    }

    #[test]
    fn tokens() {
        for t in [
            "ghp_0123456789abcdefghijABCDEFGHIJ012345",
            "gho_abcdefghijklmnopqrstuvwxyz0123",
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
            "AKIAIOSFODNN7EXAMPLE",
            "xoxb-1234567890-abcdefghij",
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
            "sk_live_abcdefghijklmnop1234",
            "AIzaSyA-abcdefghijklmnopqrstuvwxyz012345",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        ] {
            let r = g(&format!("value {t} end"));
            assert_eq!(r.text, "value [REDACTED:token] end", "{t}");
        }
    }

    #[test]
    fn auth_and_assignments() {
        assert_eq!(g("Authorization: Bearer abc.def.ghijklmnop").text, "Authorization: Bearer [REDACTED:token]");
        assert_eq!(g("curl -H 'authorization: token 0123456789abcdef'").text, "curl -H 'authorization: token [REDACTED:token]'");
        assert_eq!(g("password=hunter22 user=x").text, "password=[REDACTED:token] user=x");
        assert_eq!(g(r#"{"api_key": "abcd1234", "ok": 1}"#).text, r#"{"api_key": [REDACTED:token], "ok": 1}"#);
        assert_eq!(g("DB_PASSWORD: 's3cr3t pass'").text, "DB_PASSWORD: [REDACTED:token]");
        assert_eq!(g("GITHUB_TOKEN=ghp_shortbutstillsecret").text, "GITHUB_TOKEN=[REDACTED:token]");
        assert_eq!(g("client_secret=xyz&grant=1").text, "client_secret=[REDACTED:token]&grant=1");
    }

    #[test]
    fn urls_and_emails() {
        assert_eq!(g("git clone https://bob:pw123@github.com/x/y").text, "git clone https://[REDACTED:url_credentials]@github.com/x/y");
        assert_eq!(g("contact me at someone.name+tag@example.co.uk please").text, "contact me at [REDACTED:email] please");
        // a git ssh remote is not an email address with a TLD, but `git@github.com` is: redacting it is harmless
        assert_eq!(g("plain https://github.com/a/b stays").text, "plain https://github.com/a/b stays");
    }

    #[test]
    fn ip_addresses() {
        assert_eq!(g("connect 192.168.1.20:8080 failed").text, "connect [REDACTED:ip]:8080 failed");
        assert_eq!(g("from 8.8.8.8").text, "from [REDACTED:ip]");
        assert_eq!(g("peer 2001:db8:85a3::8a2e:370:7334 closed").text, "peer [REDACTED:ip] closed");
        assert_eq!(g("link fe80::1ff:fe23:4567:890a%eth0 up").text, "link [REDACTED:ip] up");
        // not addresses
        for s in [
            "CYW 0.1.3-alpha on Windows 10.0.26200.1",
            "version 1.2.3.4.5",
            "v1.2.3.4",
            "at 12:30:45 the job ended",
            "std::fs::read failed",
            "loopback 127.0.0.1:8787 and ::1",
            "listen 0.0.0.0",
            "999.1.1.1",
            "sha deadbeef::cafe",
        ] {
            assert_eq!(g(s).text, s, "{s}");
        }
    }

    #[test]
    fn mac_addresses() {
        assert_eq!(g("nic 00:1A:2b:3C:4d:5E").text, "nic [REDACTED:mac]");
        assert_eq!(g("nic 00-1A-2B-3C-4D-5E").text, "nic [REDACTED:mac]");
    }

    #[test]
    fn home_paths_every_os() {
        assert_eq!(g(r"C:\Users\alice\AppData\Local\com.pikara.cyw\x.log").text, r"<home>\AppData\Local\com.pikara.cyw\x.log");
        assert_eq!(g("d:/users/Bob Smith/file").text, "<home> Smith/file"); // the rest of a spaced name is caught by the user rule
        assert_eq!(g("/Users/carol/Library/Logs/cyw.log").text, "<home>/Library/Logs/cyw.log");
        assert_eq!(g("open(\"/home/dave/.config/x\")").text, "open(\"<home>/.config/x\")");
        // not a home folder
        assert_eq!(g("/usr/lib/home/x and /opt/Users").text, "/usr/lib/home/x and /opt/Users");
    }

    #[test]
    fn sensitive_paths_every_os() {
        for (input, want) in [
            (r"read C:\Users\alice\.ssh\id_ed25519 failed", "read [REDACTED:path] failed"),
            ("cat ~/.aws/credentials", "cat [REDACTED:path]"),
            ("/home/bob/.gnupg/private-keys-v1.d/x.key", "[REDACTED:path]"),
            ("/Users/c/Library/Keychains/login.keychain-db", "[REDACTED:path]"),
            (r"%APPDATA%\Microsoft\Credentials\ABC", "%APPDATA%[REDACTED:path]"),
            ("/root/.kube/config", "[REDACTED:path]"),
            ("~/.docker/config.json", "[REDACTED:path]"),
        ] {
            assert_eq!(g(input).text, want, "{input}");
        }
    }

    #[test]
    fn local_identity() {
        let r = Redactor::with_identity(&["EddieSu".into(), "Bob Smith".into(), "me".into(), "root".into()], &["DESKTOP-ABC123".into()]);
        let out = r.redact(r"user eddiesu on DESKTOP-ABC123 ran D:\Projects\EddieSu\x; Bob Smith; EddieSuper stays; root stays");
        assert_eq!(out.text, r"user [REDACTED:user] on [REDACTED:host] ran D:\Projects\[REDACTED:user]\x; [REDACTED:user]; EddieSuper stays; root stays");
        assert_eq!(out.counts["user"], 3);
        assert_eq!(out.counts["host"], 1);
        // a spaced Windows user folder is fully covered by the two rules together
        let out = r.redact(r"C:\Users\Bob Smith\Desktop");
        assert!(!out.text.contains("Bob") && !out.text.contains("Smith"), "{}", out.text);
    }

    #[test]
    fn ordinary_text_untouched() {
        for s in [
            "Pikara Science Studio 在匯出影片時當機，重現步驟：1. 開啟專案 2. 按下匯出",
            "The export button does nothing after 3 tries. Expected a progress bar.",
            "runX 0.2.0-beta (x86_64) on macOS 15.1",
        ] {
            let r = g(s);
            assert_eq!(r.text, s, "{s}");
            assert_eq!(r.total(), 0);
        }
    }

    #[test]
    fn idempotent() {
        let once = g("ghp_0123456789abcdefghijABCDEFGHIJ012345 password=x 10.0.0.1 a@b.io C:\\Users\\z\\.ssh\\k");
        let twice = g(&once.text);
        assert_eq!(once.text, twice.text);
        assert_eq!(twice.total(), 0);
    }

    #[test]
    fn counts_reported() {
        let r = g("a@b.io c@d.io 10.1.1.1 ghp_0123456789abcdefghijABCDEFGHIJ012345");
        assert_eq!(r.counts["email"], 2);
        assert_eq!(r.counts["ip"], 1);
        assert_eq!(r.counts["token"], 1);
    }
}
