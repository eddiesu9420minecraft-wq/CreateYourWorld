// Captures real frames of the splash exit and main-window reveal.
// usage: node transition.mjs <exe> <outdir>
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const [exe, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const PORT = 9333;
const t0 = Date.now();
const ms = () => Date.now() - t0;
spawn(exe, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` } }).unref();
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const targets = async () => { try { return (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === "page"); } catch { return []; } };
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url); let id = 0; const p = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); } };
    ws.onopen = () => res({ send: (method, params = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) });
    ws.onerror = rej; ws.onclose = () => p.forEach((r) => r({}));
  });
}
const ev = async (c, e) => (await c.send("Runtime.evaluate", { expression: e, returnByValue: true }))?.result?.result?.value;
const shot = async (c, name) => {
  const r = await Promise.race([c.send("Page.captureScreenshot", { format: "png" }), sleep(700).then(() => ({}))]);
  if (r.result) { writeFileSync(`${out}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(ms(), "saved", name); return true; }
  return false;
};

let splash, main;
while ((!splash || !main) && ms() < 20000) {
  for (const t of await targets()) {
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      const l = await ev(c, "window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label");
      if (l === "splash" && !splash) splash = c; else if (l === "main" && !main) main = c;
    } catch {}
  }
  await sleep(20);
}
console.log(ms(), "attached", !!splash, !!main);
// Slow the CSS transitions 4× (both windows) so frames can be captured; timing logic is unchanged.
for (const c of [splash, main]) await c?.send("Animation.enable").then(() => c.send("Animation.setPlaybackRate", { playbackRate: 0.25 }));

let sframes = 0, mframes = 0;
while (ms() < 30000) {
  const exiting = splash && await ev(splash, "!!document.querySelector('.pks-exiting')").catch(() => undefined);
  if (exiting && sframes < 4 && await shot(splash, `splash-exit-${sframes}`)) sframes++;
  const playing = await ev(main, "!!document.querySelector('.pkr-play')");
  if (playing && mframes < 5 && await shot(main, `reveal-${mframes}`)) mframes++;
  const gone = await ev(main, "!document.querySelector('.pkr-overlay')");
  if (gone && mframes > 0) { await shot(main, "reveal-done"); break; }
  await sleep(40);
}
process.exit(0);
