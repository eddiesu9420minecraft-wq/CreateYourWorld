// Screenshots of every page of the running CYW main window (CDP on :9333).
// Personal path segments are masked in the DOM before capturing.
import { writeFileSync, mkdirSync } from "node:fs";
const out = process.argv[2];
const mask = process.argv[3] || "";
mkdirSync(out, { recursive: true });
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const t = (await (await fetch("http://127.0.0.1:9333/json")).json()).filter((x) => x.type === "page");
let main;
for (const x of t) {
  const ws = new WebSocket(x.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const p = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); p.get(d.id)?.(d); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
  if ((await ev("window.__TAURI_INTERNALS__.metadata.currentWindow.label")) === "main") main = { send, ev };
}
const maskJs = `(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) if (${JSON.stringify(mask)} && n.nodeValue.includes(${JSON.stringify(mask)})) n.nodeValue = n.nodeValue.split(${JSON.stringify(mask)}).join('<user>'); })()`;
const shot = async (name) => {
  await sleep(900);
  await main.ev(maskJs);
  const r = await main.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}/${name}.png`, Buffer.from(r.result.data, "base64"));
  console.log("saved", name);
};
const nav = (label) => main.ev(`[...document.querySelectorAll('.nav-item')].find(b => b.innerText.includes(${JSON.stringify(label)})).click()`);
const pages = [["home", "首頁"], ["apps", "所有應用程式"], ["installed", "已安裝應用程式"], ["updates", "更新管理"], ["downloads", "下載管理"], ["runtime", "共用運行環境"], ["settings", "設定"]];
for (const [name, label] of pages) { await nav(label); await shot(name); }
await nav("所有應用程式");
await sleep(300);
await main.ev(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('詳細資料')).click()`);
await shot("product-detail");
process.exit(0);
