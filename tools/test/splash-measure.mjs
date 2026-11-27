// Measure a real start of a Pikara app that uses the shared splash (or a baseline build without it).
//
//   node tools/test/splash-measure.mjs <config.json>
//
// config: {
//   "name": "studio-cold",            label for the output files
//   "exe": "D:/t/bin/studio-new.exe",
//   "outside": true,                  launch through explorer.exe + .cmd (escapes the Claude app's MSIX container)
//   "env": { "PIKARA_STUDIO_DATA": "...", ... },
//   "port": 9334,                     WebView2 remote-debugging port
//   "ready": "<js expr>",             main window shows its first real screen (evaluated in the main page)
//   "scenario": "normal" | "fail-retry" | "slow" | "slow-skip",
//   "fixBeforeRetry": ["path", ...],  fail-retry: files deleted (the "user fix") before clicking the primary button
//   "skipAction": "skip_network",     slow-skip: data-action of the button to press once the slow notice shows
//   "out": "D:/t/measure",            results (json + screenshots)
//   "timeoutMs": 40000
// }
//
// All times are wall-clock ms relative to the process creation time reported by Windows
// (Win32_Process.CreationDate). Polling granularity ≈ 15–25 ms.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = cfg.out;
mkdirSync(out, { recursive: true });
const PORT = cfg.port || 9334;
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const log = [];
const t0 = Date.now();
const note = (msg, extra) => {
  const e = { at: Date.now(), msg, ...(extra || {}) };
  log.push(e);
  console.log(String(e.at - t0).padStart(6), "ms", msg, extra ? JSON.stringify(extra) : "");
};

// ---------------------------------------------------------------- launch
const exe = cfg.exe.replace(/\//g, "\\");
const env = { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, ...(cfg.env || {}) };
if (cfg.outside) {
  const cmd = join(out, `${cfg.name}.cmd`).replace(/\//g, "\\");
  const lines = ["@echo off", ...Object.entries(env).map(([k, v]) => `set "${k}=${v}"`), `start "" "${exe}"`];
  writeFileSync(cmd, lines.join("\r\n") + "\r\n");
  note("launch (explorer.exe, outside the app container)", { cmd });
  spawn("explorer.exe", [cmd], { detached: true, stdio: "ignore" }).unref();
} else {
  note("launch (direct spawn)");
  spawn(exe, [], { detached: true, stdio: "ignore", env: { ...process.env, ...env } }).unref();
}

// ---------------------------------------------------------------- regression: never "Not Responding"
// Windows' own hang test (Process.Responding) sampled every 500 ms for the launched exe.
const respSamples = [];
const exeName = exe.split("\\").pop().replace(/\.exe$/i, "");
const sidecar = spawn("powershell.exe", ["-NoProfile", "-Command",
  `$end=(Get-Date).AddMilliseconds(${(cfg.timeoutMs || 40000) + 5000}); while((Get-Date) -lt $end){ Get-Process -Name '${exeName}' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe}' -and $_.MainWindowHandle -ne 0 } | ForEach-Object { "$([DateTimeOffset]::Now.ToUnixTimeMilliseconds()) $($_.Responding)" }; Start-Sleep -Milliseconds 500 }`]);
sidecar.stdout.on("data", (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => { const [t, r] = l.trim().split(" "); respSamples.push({ at: Number(t), responding: r === "True" }); }));
// IPC round trip through the main thread (every IPC message is dispatched there), probed from the splash page.
const ipc = { samples: 0, maxMs: 0, over1s: 0 };

// ---------------------------------------------------------------- CDP
async function targets() {
  try { return (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === "page"); } catch { return []; }
}
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url); let id = 0; const p = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); } };
    ws.onopen = () => res({ send: (method, params = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }), ws, closed: false });
    ws.onerror = rej;
    ws.onclose = function () { p.forEach((r) => r({})); };
  });
}
async function ev(c, expression, ms = 2000) {
  const r = await Promise.race([c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }), sleep(ms).then(() => ({}))]);
  if (!r.result) throw new Error("closed");
  return r.result.result?.value;
}
// screenshots run in the background so they never stall the 15 ms state polling
const shots = [];
function shot(c, file) {
  const p = Promise.race([c.send("Page.captureScreenshot", { format: "png" }), sleep(3000).then(() => ({}))])
    .then((r) => { if (r.result) { writeFileSync(join(out, file), Buffer.from(r.result.data, "base64")); note("screenshot", { file }); } });
  shots.push(p);
  return p;
}

const SPLASH_STATE = `(() => { const r = document.querySelector('.pks-root'); if (!r) return { vis: document.visibilityState, mounted: false };
  const q = (s) => document.querySelector(s);
  const note = q('.pks-note');
  return { vis: document.visibilityState, mounted: true, msg: q('.pks-msg')?.textContent, count: q('.pks-count')?.textContent,
    segs: [...document.querySelectorAll('.pks-seg')].map((s) => s.dataset.state).join(','),
    failed: r.classList.contains('pks-failed'), failTitle: q('.pks-fail-title')?.textContent || null,
    slow: !!note && !note.hidden, slowText: note && !note.hidden ? q('.pks-note-text')?.textContent : null,
    warn: q('.pks-warn') && !q('.pks-warn').hidden ? q('.pks-warn').textContent : null,
    exiting: r.classList.contains('pks-exiting'), version: q('.pks-version')?.textContent,
    actions: [...document.querySelectorAll('.pks-btn[data-action]')].map((b) => b.dataset.action) }; })()`;
const MAIN_STATE = `(() => ({ vis: document.visibilityState, ready: !!(${cfg.ready}), overlay: !!document.querySelector('.pkr-overlay') }))()`;

let splash = null, main = null;
const attached = new Set();
let splashState = "", mainState = "";
const marks = {};
const mark = (k, extra) => { if (!(k in marks)) { marks[k] = Date.now(); note(k, extra); } };
const deadline = Date.now() + (cfg.timeoutMs || 40000);
let retried = false, skipped = false, slowShot = false, failShot = false, splashShot = false;

while (Date.now() < deadline) {
  if (!splash || !main) {
    for (const t of await targets()) {
      if (attached.has(t.id) || !/^(https?|tauri):/.test(t.url)) continue;
      const c = await connect(t.webSocketDebuggerUrl).catch(() => null);
      if (!c) continue;
      const label = await ev(c, "window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label").catch(() => null);
      if (!label) { c.ws.close(); continue; }
      attached.add(t.id);
      if (label === "splash" && !splash) {
        splash = c; mark("splash page attached", { url: t.url });
        if (cfg.colorScheme) await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: cfg.colorScheme }] });
      } else if (label === "main" && !main) { main = c; mark("main page attached", { url: t.url }); }
      else c.ws.close();
    }
  }
  if (splash && splash !== "closed") {
    try {
      const s = await ev(splash, SPLASH_STATE, 400);
      const key = JSON.stringify(s);
      if (key !== splashState) { splashState = key; note("splash", s); }
      if (s.vis === "visible") mark("splash visible");
      if (s.vis === "visible" && s.mounted && s.count && !splashShot) { splashShot = true; shot(splash, `${cfg.name}-splash.png`); const c = splash; setTimeout(() => c !== "closed" && shot(c, `${cfg.name}-splash-later.png`), 900); }
      if (s.failed) {
        mark("failure shown", { title: s.failTitle, actions: s.actions });
        if (!failShot) { failShot = true; await sleep(300); await shot(splash, `${cfg.name}-failure.png`); }
        if (cfg.scenario === "fail-quit" && !retried) {
          retried = true;
          mark("quit clicked");
          await ev(splash, "document.querySelector('.pks-btn[data-action=quit]')?.click()");
          await sleep(1500);
          break;
        }
        // holdFailureMs: stay on the error screen first (e.g. > Windows' 5 s hang threshold) to prove it stays responsive
        if (cfg.scenario === "fail-retry" && !retried && Date.now() - marks["failure shown"] >= (cfg.holdFailureMs || 0)) {
          retried = true;
          for (const f of cfg.fixBeforeRetry || []) { rmSync(f, { force: true }); note("user fix: deleted", { f }); }
          mark("retry clicked");
          await ev(splash, "document.querySelector('.pks-btn-primary')?.click()");
        }
      }
      if (s.slow) {
        mark("slow notice shown", { text: s.slowText, actions: s.actions });
        if (!slowShot) { slowShot = true; shot(splash, `${cfg.name}-slow.png`); }
        if (cfg.scenario === "slow-skip" && !skipped && s.actions.includes(cfg.skipAction)) {
          skipped = true;
          mark("skip clicked", { action: cfg.skipAction });
          await ev(splash, `document.querySelector('.pks-btn[data-action="${cfg.skipAction}"]')?.click()`);
        }
      }
      if (s.exiting) mark("splash exit started");
      if (s.mounted && !s.exiting && Date.now() - (ipc.last || 0) > 250) {
        ipc.last = Date.now();
        const rt = await ev(splash, "(async () => { const t = performance.now(); await window.__TAURI_INTERNALS__.invoke('plugin:pikara-splash|status').catch(() => {}); return performance.now() - t; })()", 3000);
        if (typeof rt === "number") { ipc.samples++; ipc.maxMs = Math.max(ipc.maxMs, Math.round(rt)); if (rt > 1000) ipc.over1s++; }
        else { ipc.samples++; ipc.over1s++; ipc.maxMs = Math.max(ipc.maxMs, 3000); }
      }
    } catch {
      mark("splash window closed");
      splash = "closed";
    }
  }
  if (main) {
    try {
      const m = await ev(main, MAIN_STATE);
      const key = JSON.stringify(m);
      if (key !== mainState) { mainState = key; note("main", m); }
      if (m.vis === "visible") mark("main visible");
      if (m.vis === "visible" && m.ready) mark("main ready on screen");
      if (m.vis === "visible" && m.ready && !m.overlay && (splash === "closed" || !splash)) break;
    } catch { note("main page lost"); main = null; }
  }
  await sleep(15);
}
if (Date.now() >= deadline) note("TIMEOUT");

// ---------------------------------------------------------------- results
let backend = null;
if (main) {
  backend = await ev(main, "window.__TAURI_INTERNALS__.invoke('plugin:pikara-splash|status').catch(e => ({ error: String(e) }))").catch(() => null);
  await sleep(400);
  await shot(main, `${cfg.name}-main.png`);
  await Promise.all(shots);
}
const ps = `Get-CimInstance Win32_Process -Filter "Name='${exe.split("\\").pop()}'" | Where-Object { $_.ExecutablePath -eq '${exe}' } | ForEach-Object { "$($_.ProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }`;
const procs = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(" ").map(Number));
const mine = procs.filter(([, created]) => created >= t0 - 3000).sort((a, b) => a[1] - b[1]);
const [pid, created] = mine[0] || [null, null];
const rel = (t) => (t && created ? t - created : null);
sidecar.kill();
const notResponding = respSamples.filter((x) => !x.responding);
const regression = {
  respondingSamples: respSamples.length, notRespondingSamples: notResponding.length,
  ipcProbes: ipc.samples, ipcMaxRoundTripMs: ipc.maxMs, ipcOver1s: ipc.over1s,
  pass: notResponding.length === 0 && ipc.over1s === 0,
};
const result = {
  regression,
  name: cfg.name, exe: cfg.exe, scenario: cfg.scenario || "normal", env: cfg.env || {}, pid,
  processCreatedUnixMs: created,
  harnessLaunchToProcessMs: created ? created - t0 : null,
  sinceProcessStart: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, rel(v)])),
  backend: backend && !backend.error ? {
    testHooks: backend.testHooks, version: backend.version, warnings: backend.warnings,
    steps: backend.steps.map((s) => ({ id: s.id, state: s.state, ms: s.ms, detail: s.detail })),
    // plugin start → event (the plugin is created inside the process; add pluginStartSinceProcess for absolute)
    pluginStartSinceProcessMs: created ? backend.timings.startedUnixMs - created : null,
    timings: backend.timings,
    // the moments that matter, in ms since process creation
    sinceProcessStart: created ? Object.fromEntries(["shownMs", "backendDoneMs", "frontendReadyMs", "completeMs", "revealedMs"]
      .map((k) => [k, backend.timings[k] == null ? null : backend.timings.startedUnixMs - created + backend.timings[k]])) : null,
  } : backend,
  log: log.map((e) => ({ ...e, at: rel(e.at) })),
};
writeFileSync(join(out, `${cfg.name}.json`), JSON.stringify(result, null, 2));
console.log("RESULT", JSON.stringify({ name: cfg.name, pid, ...result.sinceProcessStart }));
console.log("RESPONSIVENESS", JSON.stringify(regression));
if (!regression.pass) process.exitCode = 1;
if (pid && !cfg.keep) {
  // only the test process we launched (matched by its exe path and creation time); never another Studio/CYW
  try { execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); note("killed test process", { pid }); } catch {}
}
