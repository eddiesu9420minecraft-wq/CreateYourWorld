// Runs launch-hidden.ps1 OUTSIDE the Claude app container with no visible console:
// writes a one-off .vbs (WScript runs PowerShell with window style 0) and asks Explorer,
// which lives outside the container, to open it.
//
// usage: node run-hidden.mjs [--wait] [--env K=V ...] <exe> [args...]
// prints the launched PID (or the exit code with --wait).
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const work = path.join(here, "..", "..", "..", ".tmp", "hidden");
mkdirSync(work, { recursive: true });

const argv = process.argv.slice(2);
let wait = false; const env = [];
while (argv[0]?.startsWith("--")) {
  const f = argv.shift();
  if (f === "--wait") wait = true;
  else if (f === "--env") env.push(argv.shift());
}
const [exe, ...rest] = argv;
const tag = `${Date.now()}`;
const pidFile = path.join(work, `${tag}.pid`);
const exitFile = path.join(work, `${tag}.exit`);
const ps1 = path.join(here, "launch-hidden.ps1");
const q = (s) => s.replace(/'/g, "''");
const psArgs = [
  `-Exe '${q(exe)}'`,
  rest.length ? `-Arguments '${q(rest.join(" "))}'` : "",
  env.length ? `-Env ${env.map((e) => `'${q(e)}'`).join(",")}` : "",
  `-PidFile '${q(pidFile)}'`,
  wait ? `-Wait -ExitFile '${q(exitFile)}'` : "",
].filter(Boolean).join(" ");
// -Command (not -File): with -File, single quotes are passed through literally.
const psCmd = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& '${q(ps1)}' ${psArgs}"`;
const vbs = path.join(work, `${tag}.vbs`);
// VBScript string: double the quotes.
writeFileSync(vbs, `CreateObject("WScript.Shell").Run "${psCmd.replace(/"/g, '""')}", 0, False\r\n`);
spawnSync("explorer.exe", [vbs]);

const deadline = Date.now() + (wait ? 600_000 : 30_000);
const target = wait ? exitFile : pidFile;
while (Date.now() < deadline && !(existsSync(target) && readFileSync(target, "utf8").trim())) {
  await new Promise((r) => setTimeout(r, 250));
}
if (!existsSync(target)) { console.error("timed out waiting for", target); process.exit(1); }
console.log(readFileSync(target, "utf8").trim());
rmSync(vbs, { force: true });
