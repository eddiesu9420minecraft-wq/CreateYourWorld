// Build the `cyw` CLI for the Tauri target and place it where `bundle.externalBin` expects it:
// src-tauri/binaries/cyw-<target-triple>[.exe]. Runs as part of `beforeBuildCommand`.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)[1];
const target = process.env.TAURI_ENV_TARGET_TRIPLE || host;
const exe = target.includes("windows") ? ".exe" : "";
const args = ["build", "--release", "--manifest-path", path.join(root, "crates", "cyw-cli", "Cargo.toml"), "--target", target];
console.log(`[cyw sidecar] cargo ${args.join(" ")}`);
execFileSync("cargo", args, { stdio: "inherit" });
const targetDir = process.env.CARGO_TARGET_DIR || path.join(root, "crates", "cyw-cli", "target");
const built = path.join(targetDir, target, "release", `cyw${exe}`);
const dest = path.join(root, "src-tauri", "binaries", `cyw-${target}${exe}`);
mkdirSync(path.dirname(dest), { recursive: true });
copyFileSync(built, dest);
console.log(`[cyw sidecar] ${dest} (${statSync(dest).size} bytes)`);
