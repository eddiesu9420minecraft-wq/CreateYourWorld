// Launch CYW with CDP enabled and record what the splash really shows, with timings.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const exe = process.argv[2];
const out = process.argv[3];
const PORT = 9333;
const t0 = Date.now();
const ms = () => `${String(Date.now() - t0).padStart(5)}ms`;
const child = spawn(exe, [], {
  detached: true, stdio: "ignore",
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
});
child.unref();

const sleep = (n) => new Promise((r) => setTimeout(r, n));
async function targets() {
  try { return (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === "page"); } catch { return []; }
}
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url); let id = 0; const p = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); } };
    ws.onopen = () => res({ send: (method, params = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }), ws });
    ws.onerror = rej; ws.onclose = () => p.forEach((r) => r({}));
  });
}
const ev = async (c, e) => (await c.send("Runtime.evaluate", { expression: e, returnByValue: true }))?.result?.result?.value;

let splash = null, main = null, shot = false, last = "";
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  if (!splash || !main) {
    for (const t of await targets()) {
      try {
        const c = await connect(t.webSocketDebuggerUrl);
        const l = await ev(c, "window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label");
        if (l === "splash" && !splash) { splash = c; console.log(ms(), "splash page attached"); }
        else if (l === "main" && !main) { main = c; console.log(ms(), "main page attached"); }
        else c.ws.close();
      } catch {}
    }
  }
  if (splash) {
    const s = await ev(splash, "(() => { const el = document.querySelector('.pks-status'); return el ? el.innerText.replace(/\\n/g,' ') + (document.querySelector('.pks-exiting') ? ' [exiting]' : '') : null })()");
    if (s === undefined) { console.log(ms(), "splash window closed"); splash = "closed"; }
    else if (s && s !== last) { console.log(ms(), "splash:", s); last = s; }
    if (s && !shot && true) {
      const r = await Promise.race([splash.send("Page.captureScreenshot", { format: "png" }), sleep(800).then(() => ({}))]);
      if (r.result) { writeFileSync(`${out}-splash.png`, Buffer.from(r.result.data, "base64")); shot = true; console.log(ms(), "splash screenshot saved"); }
    }
  }
  if (main && splash === "closed") {
    await sleep(1200);
    const overlay = await ev(main, "!!document.querySelector('.pkr-overlay')");
    console.log(ms(), "main overlay still present:", overlay, "| visibility:", await ev(main, "document.visibilityState"));
    const r = await main.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${out}-home.png`, Buffer.from(r.result.data, "base64"));
    console.log(ms(), "home screenshot saved");
    break;
  }
  await sleep(splash && splash !== "closed" ? 30 : 150);
}
process.exit(0);
