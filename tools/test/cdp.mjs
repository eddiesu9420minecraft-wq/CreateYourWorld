// Tiny CDP client for driving the CYW WebView2 windows during testing.
// usage: node cdp.mjs eval <label> "<js expr>"  |  node cdp.mjs shot <label> <out.png>  |  node cdp.mjs list
import { writeFileSync } from "node:fs";
const PORT = process.env.CDP_PORT || 9333;
const [cmd, label, arg] = process.argv.slice(2);

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await r.json()).filter((t) => t.type === "page");
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    };
    ws.onopen = () => res({
      send: (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }),
      close: () => ws.close(),
    });
    ws.onerror = rej;
  });
}

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
  return r.result?.result?.value;
}

async function byLabel(want) {
  for (const t of await targets()) {
    const c = await connect(t.webSocketDebuggerUrl);
    const l = await evalIn(c, "window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label");
    if (l === want) return c;
    c.close();
  }
  throw new Error(`no window ${want}`);
}

if (cmd === "list") {
  for (const t of await targets()) {
    const c = await connect(t.webSocketDebuggerUrl);
    console.log(await evalIn(c, "window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label"), t.url);
    c.close();
  }
} else if (cmd === "eval") {
  const c = await byLabel(label);
  console.log(JSON.stringify(await evalIn(c, arg), null, 1));
  c.close();
} else if (cmd === "shot") {
  const c = await byLabel(label);
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(arg, Buffer.from(r.result.data, "base64"));
  console.log("saved", arg);
  c.close();
}
process.exit(0);
