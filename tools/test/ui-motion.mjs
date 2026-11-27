// UI animation regression + performance check against a running CYW main window (CDP :9333).
// Designed to run on the invisible desktop (no windows on the user's screen).
// usage: node ui-motion.mjs  → prints a JSON report, exits 1 on any failure.
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const report = { checks: [], errors: [] };
const ok = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, detail }); };

const targets = (await (await fetch("http://127.0.0.1:9333/json")).json()).filter((t) => t.type === "page");
let c;
for (const t of targets) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); const listeners = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) pend.get(d.id)?.(d); else listeners.forEach((f) => f(d)); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
  if ((await ev("window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label")) === "main") { c = { send, ev, listeners }; break; }
}
if (!c) { console.error("main window not found"); process.exit(1); }

await c.send("Runtime.enable");
await c.send("Performance.enable");
c.listeners.push((d) => {
  if (d.method === "Runtime.exceptionThrown") report.errors.push(d.params.exceptionDetails?.exception?.description ?? "exception");
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") report.errors.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
});
const metric = async (name) => (await c.send("Performance.getMetrics")).result.metrics.find((m) => m.name === name)?.value ?? 0;
const nav = (label) => c.ev(`[...document.querySelectorAll('.nav-item')].find(b => b.innerText.includes(${JSON.stringify(label)})).click()`);

// Collects every animation that runs during `ms` after `action`, with its animated properties,
// plus rAF frame timing and layout count.
const PROBE = `(window.__probe = (ms) => new Promise((resolve) => {
  const seen = new Map(); const frames = []; const t0 = performance.now();
  const props = (a) => {
    if (a.transitionProperty) return [a.transitionProperty];
    try { return [...new Set(a.effect.getKeyframes().flatMap(k => Object.keys(k)).filter(k => !['offset','easing','composite','computedOffset'].includes(k)))]; } catch { return ['?']; }
  };
  const tick = (now) => {
    frames.push(now);
    for (const a of document.getAnimations()) if (!seen.has(a)) seen.set(a, { props: props(a), dur: a.effect?.getTiming?.().duration });
    if (now - t0 < ms) requestAnimationFrame(tick); else {
      const gaps = frames.slice(1).map((f, i) => f - frames[i]);
      resolve({ animations: [...seen.values()], frames: frames.length, maxGap: Math.max(0, ...gaps), avgGap: gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1) });
    }
  };
  requestAnimationFrame(tick);
}), true)`;
await c.ev(PROBE);
const ALLOWED = new Set(["transform", "opacity", "background-color", "border-color", "color", "outline-color"]);
const badProps = (anims) => anims.flatMap((a) => a.props).filter((p) => !ALLOWED.has(p));

// ---- 1. every page renders; page transition animates only transform/opacity -------------
const pages = ["所有應用程式", "已安裝應用程式", "更新管理", "下載管理", "共用運行環境", "設定", "首頁"];
const fpsSamples = [];
for (const label of pages) {
  const l0 = await metric("LayoutCount");
  const probe = c.ev("window.__probe(520)");
  await nav(label);
  const p = await probe;
  const l1 = await metric("LayoutCount");
  const active = await c.ev(`document.querySelector('.nav-item.active')?.innerText.includes(${JSON.stringify(label)}) && document.querySelectorAll('.nav-indicator').length === 1 && !!document.querySelector('.nav-item.active .nav-indicator')`);
  const content = await c.ev("document.querySelector('main.scroll')?.innerText.trim().length || 0");
  ok(`page ${label}: renders, indicator on active item`, active && content > 0, { contentChars: content });
  ok(`page ${label}: only compositor-friendly properties animated`, badProps(p.animations).length === 0, { animated: [...new Set(p.animations.flatMap((a) => a.props))], bad: badProps(p.animations) });
  fpsSamples.push({ page: label, frames: p.frames, avgFrameMs: +p.avgGap.toFixed(1), maxFrameMs: +p.maxGap.toFixed(1), layouts: l1 - l0, animations: p.animations.length });
}
report.transitions = fpsSamples;

// ---- 2. modal open/close --------------------------------------------------------------------
await nav("所有應用程式"); await sleep(400);
const mp = c.ev("window.__probe(450)");
await c.ev(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('詳細資料')).click()`);
const mprobe = await mp;
ok("modal opens", await c.ev("!!document.querySelector('.modal')"));
ok("modal animates only transform/opacity", badProps(mprobe.animations).length === 0, { animated: [...new Set(mprobe.animations.flatMap((a) => a.props))] });
await c.ev(`document.querySelector('.modal .icon-btn').click()`);
await sleep(120);
const stillDuringExit = await c.ev("!!document.querySelector('.modal')");
await sleep(400);
ok("modal exit animation then unmount", (await c.ev("!document.querySelector('.modal')")), { presentDuringExit: stillDuringExit });

// ---- 3. toast appears and leaves -----------------------------------------------------------
await nav("設定"); await sleep(400);
await c.ev(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('清除快取')).click()`);
await sleep(300);
const toastKind = await c.ev("document.querySelector('.toast')?.className || ''");
ok("toast shown", toastKind.length > 0, { kind: toastKind, text: await c.ev("document.querySelector('.toast')?.innerText || ''") });
// ok/info toasts stay 4 s, error toasts 8 s; then a short exit animation.
await sleep(toastKind.includes("toast-error") ? 8600 : 4600);
ok("toast removed after its timeout (with exit animation)", await c.ev("document.querySelectorAll('.toast').length === 0"));

// ---- 4. progress bar uses transform ---------------------------------------------------------
const progressOk = await c.ev(`(() => { const d = document.createElement('div'); d.className = 'progress'; d.innerHTML = '<div class="progress-fill"></div>'; document.body.appendChild(d);
  const cs = getComputedStyle(d.firstChild); const r = { transition: cs.transitionProperty, origin: cs.transformOrigin }; d.remove(); return r; })()`);
ok("progress fill transitions transform (not width)", progressOk.transition.includes("transform") && !progressOk.transition.includes("width"), progressOk);

// ---- 5. idle: nothing animating, ~no CPU ----------------------------------------------------
await nav("首頁"); await sleep(2500);
const t0 = await metric("TaskDuration"); const s0 = await metric("ScriptDuration");
await sleep(10000);
const idleTask = (await metric("TaskDuration")) - t0; const idleScript = (await metric("ScriptDuration")) - s0;
const idleAnims = await c.ev("document.getAnimations().filter(a => a.playState === 'running').length");
report.idle = { seconds: 10, taskMs: +(idleTask * 1000).toFixed(1), scriptMs: +(idleScript * 1000).toFixed(1), runningAnimations: idleAnims };
ok("idle: no running animations", idleAnims === 0, report.idle);
ok("idle: main-thread work < 1% over 10 s", idleTask < 0.1, report.idle);

// ---- 6. animations off ----------------------------------------------------------------------
const inv = (cmd, args = {}) => c.ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const orig = await inv("get_settings");
await inv("save_settings", { settings: { ...orig, uiMotion: "off" } });
await c.ev("location.reload()"); await sleep(3500); await c.ev(PROBE);
ok("setting off → html[data-motion=off]", (await c.ev("document.documentElement.dataset.motion")) === "off");
const offProbe = c.ev("window.__probe(400)");
await nav("所有應用程式");
const off = await offProbe;
const longOnes = off.animations.filter((a) => (a.dur ?? 0) > 1);
ok("animations off: nothing longer than 1 ms runs", longOnes.length === 0, { animations: off.animations.length, long: longOnes });
await inv("save_settings", { settings: orig });
await c.ev("location.reload()"); await sleep(3500);
ok("setting restored", (await c.ev("document.documentElement.dataset.motion")) === (orig.uiMotion ?? "system"));

ok("no JS errors or console errors", report.errors.length === 0, report.errors);
const failed = report.checks.filter((x) => !x.pass);
console.log(JSON.stringify({ passed: report.checks.length - failed.length, failed: failed.length, ...report }, null, 1));
process.exit(failed.length ? 1 : 0);
