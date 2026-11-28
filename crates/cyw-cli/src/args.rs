//! Short forms → regular subcommands, before clap parses (so every form reaches the same code).
//!
//! | Typed                                   | Means                                          |
//! |-----------------------------------------|------------------------------------------------|
//! | `cyw /run X …`, `cyw -r X …`            | `cyw run X …`                                  |
//! | `cyw -m update [v]`                     | `cyw self update [v]`                          |
//! | `cyw -m list software`                  | `cyw list software`                            |
//! | `cyw -m list V` (`v`, `versions`)       | `cyw self versions`                            |
//! | `cyw -m list installed`                 | `cyw list installed`                           |
//! | `cyw -m <App> list plugins|installed`   | `cyw plugin --software <App> list plugins|installed` |
//! | `cyw -m <App> download <p> [-- install]`| `cyw plugin --software <App> install <p>`      |
//! | `cyw -m <App> remove|update|enable|disable|rollback <p>` | `cyw plugin --software <App> …` |
//! | `cyw download <p> -- install`           | `cyw download <p> --install`                   |
//!
//! Only these exact shapes are rewritten; anything after a `run`'s `--` is passed to the program untouched.

use std::ffi::OsString;

fn s(a: &OsString) -> Option<&str> {
    a.to_str()
}

const GLOBAL_FLAGS: &[&str] = &["--json", "-q", "--quiet", "-v", "--verbose", "-y", "--yes"];

pub fn normalize(raw: Vec<OsString>) -> Vec<OsString> {
    let mut it = raw.into_iter();
    let mut out: Vec<OsString> = it.next().into_iter().collect(); // program name
    let rest: Vec<OsString> = it.collect();
    // leading global flags stay in front
    let mut i = 0;
    while i < rest.len() {
        match s(&rest[i]) {
            Some(f) if GLOBAL_FLAGS.contains(&f) => {
                out.push(rest[i].clone());
                i += 1;
            }
            Some("--lang") if i + 1 < rest.len() => {
                out.push(rest[i].clone());
                out.push(rest[i + 1].clone());
                i += 2;
            }
            _ => break,
        }
    }
    let tail = &rest[i..];
    let first = tail.first().and_then(s);
    let o = |x: &str| OsString::from(x);
    let mut mapped: Vec<OsString> = match first {
        Some("/run") | Some("-r") => std::iter::once(o("run")).chain(tail[1..].iter().cloned()).collect(),
        Some("-m") => {
            let a = tail.get(1).and_then(s);
            let b = tail.get(2).and_then(s);
            match (a, b) {
                (Some("update"), _) => [o("self"), o("update")].into_iter().chain(tail[2..].iter().cloned()).collect(),
                (Some("list"), Some(w)) if ["software", "s", "apps"].contains(&w) => vec![o("list"), o("software")],
                (Some("list"), Some(w)) if ["V", "v", "version", "versions"].contains(&w) => vec![o("self"), o("versions")],
                (Some("list"), Some(w)) if ["installed", "i"].contains(&w) => vec![o("list"), o("installed")],
                (Some("list"), None) => vec![o("list"), o("software")],
                (Some(app), Some(_)) => {
                    // -m <App> <plugin command …>
                    let mut v = vec![o("plugin"), o("--software"), o(app)];
                    let cmd = &tail[2..];
                    match cmd.first().and_then(s) {
                        Some("download") => {
                            v.push(o("install"));
                            v.extend(strip_install(&cmd[1..]));
                        }
                        Some("list") => {
                            v.push(o("list"));
                            v.extend(cmd[1..].iter().cloned());
                        }
                        _ => v.extend(cmd.iter().cloned()),
                    }
                    v
                }
                _ => tail.to_vec(),
            }
        }
        Some("download") => {
            let mut v = vec![o("download")];
            let body = &tail[1..];
            if has_dashdash_install(body) {
                v.extend(strip_install(body));
                v.push(o("--install"));
            } else {
                v.extend(body.iter().cloned());
            }
            v
        }
        _ => tail.to_vec(),
    };
    out.append(&mut mapped);
    out
}

fn has_dashdash_install(args: &[OsString]) -> bool {
    args.windows(2).any(|w| s(&w[0]) == Some("--") && s(&w[1]) == Some("install"))
}

/// Drop `-- install` / `--install` (the plugin route installs anyway).
fn strip_install(args: &[OsString]) -> Vec<OsString> {
    let mut v = vec![];
    let mut i = 0;
    while i < args.len() {
        match s(&args[i]) {
            Some("--") if args.get(i + 1).and_then(s) == Some("install") => i += 2,
            Some("--install") => i += 1,
            _ => {
                v.push(args[i].clone());
                i += 1;
            }
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(a: &str) -> String {
        let v: Vec<OsString> = std::iter::once("cyw").chain(a.split_whitespace()).map(OsString::from).collect();
        normalize(v).iter().skip(1).map(|x| x.to_string_lossy().to_string()).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn documented_short_forms() {
        assert_eq!(n("/run PikaraScienceStudio"), "run PikaraScienceStudio");
        assert_eq!(n("/run PikaraScienceStudio -- nogui"), "run PikaraScienceStudio -- nogui");
        assert_eq!(n("-r PikaraScienceStudio"), "run PikaraScienceStudio");
        assert_eq!(n("-m update"), "self update");
        assert_eq!(n("-m update v3.0.1"), "self update v3.0.1");
        assert_eq!(n("-m list software"), "list software");
        assert_eq!(n("-m list V"), "self versions");
        assert_eq!(n("--json -m list installed"), "--json list installed");
        assert_eq!(n("download runx --version v1.0.0"), "download runx --version v1.0.0");
        assert_eq!(n("download VoicePack -- install"), "download VoicePack --install");
        assert_eq!(n("-m runX download Examples -- install"), "plugin --software runX install Examples");
        assert_eq!(n("-m runX download Examples --install"), "plugin --software runX install Examples");
        assert_eq!(n("-m runX list plugins"), "plugin --software runX list plugins");
        assert_eq!(n("-m runX list installed"), "plugin --software runX list installed");
        assert_eq!(n("-m runX remove Examples"), "plugin --software runX remove Examples");
        assert_eq!(n("-m runX update --all"), "plugin --software runX update --all");
        assert_eq!(n("list installed"), "list installed");
        assert_eq!(n("update --all"), "update --all");
    }

    #[test]
    fn program_arguments_after_dashdash_are_untouched() {
        assert_eq!(n("run runX -- hello.rux -o -m list V"), "run runX -- hello.rux -o -m list V");
        assert_eq!(n("/run runX -- -- install"), "run runX -- -- install");
    }
}
