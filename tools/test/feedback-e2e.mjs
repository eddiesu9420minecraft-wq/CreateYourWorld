// Feedback Center end-to-end test: the real CYW window (CDP :9333) against the real local backend
// (`services/feedback`, `npm run dev`, ENVIRONMENT=development). Runs on the invisible desktop.
//
// usage: node feedback-e2e.mjs <fixtures-dir> <screenshots-dir>  → JSON report; exit 1 on any failure.
// The app must be started with PIKARA_CYW_FEEDBACK_API=http://127.0.0.1:8787 and an isolated PIKARA_CYW_DATA_DIR.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const [fixtures, shots] = process.argv.slice(2).map((p) => path.resolve(p));
mkdirSync(fixtures, { recursive: true });
mkdirSync(shots, { recursive: true });
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const report = { checks: [], errors: [] };
const ok = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, ...(detail !== undefined ? { detail } : {}) }); if (!pass) console.error("FAIL", name, detail ?? ""); };

// ---- fixtures: a PNG carrying a tEXt chunk with a name, and a log full of secrets ----
const crc32 = (buf) => { let c, crc = 0xffffffff; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const zlibIdat = Buffer.from([0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, 0x00, 0xf5, 0xb3, 0x01, 0xff, 0x06, 0xf3, 0x02, 0xa9]); // 1×1 RGBA gold pixel (stored deflate)
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
  chunk("tEXt", Buffer.from("Author\0e2e-secret-author")),
  chunk("IDAT", zlibIdat),
  chunk("IEND", Buffer.alloc(0)),
]);
const pngPath = path.join(fixtures, "screenshot.png");
writeFileSync(pngPath, png);
const SECRETS = ["ghp_E2Eabcdefghijklmnopqrstuvwxyz012345", "hunter2-e2e", "203.0.113.77", "e2e.person@example.com", "e2e-secret-author"];
const logPath = path.join(fixtures, "studio.log");
writeFileSync(logPath, `[info] start\nGITHUB_TOKEN=${SECRETS[0]}\npassword=${SECRETS[1]}\nconnect ${SECRETS[2]}:443 failed\nmail ${SECRETS[3]}\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----\n`);

// ---- CDP ----
const targets = (await (await fetch("http://127.0.0.1:9333/json")).json()).filter((t) => t.type === "page");
let c;
for (const t of targets) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); const listeners = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) pend.get(d.id)?.(d); else listeners.forEach((f) => f(d)); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result?.result?.value; };
  if ((await ev("window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label")) === "main") { c = { send, ev, listeners }; break; }
}
if (!c) { console.error("main window not found"); process.exit(1); }
await c.send("Runtime.enable");
await c.send("DOM.enable");
c.listeners.push((d) => {
  if (d.method === "Runtime.exceptionThrown") report.errors.push(d.params.exceptionDetails?.exception?.description ?? "exception");
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") report.errors.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
});

const J = JSON.stringify;
const invoke = (cmd, args = {}) => c.ev(`window.__TAURI_INTERNALS__.invoke(${J(cmd)}, ${J(args)}).then(v => ({ ok: v }), e => ({ err: String(e) }))`);
const text = () => c.ev("document.body.innerText");
const clickNow = (sel, label) => c.ev(`(() => { const b = [...document.querySelectorAll(${J(sel)})].find(b => b.innerText.includes(${J(label)}) && !b.disabled); if (!b) return false; b.click(); return true; })()`);
const disabled = (label) => c.ev(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.innerText.includes(${J(label)})); return b ? b.disabled : null; })()`);
const setField = (selector, value, index = 0) => c.ev(`(() => { const el = document.querySelectorAll(${J(selector)})[${index}]; if (!el) return false;
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${J(value)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
// clicks wait (≤ 6 s) for the button to exist and be enabled
const click = async (sel, label) => { for (let i = 0; i < 40; i++) { if (await clickNow(sel, label)) return true; await sleep(150); } return false; };
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150); } return false; };
const shot = async (name) => { await sleep(500); const r = await c.send("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.result.data, "base64")); };
const nav = (label) => click(".nav-item", label);
const closeModal = () => c.ev(`document.querySelector('.modal-head .icon-btn')?.click()`);

// ---- 1. page + service ----
await nav("反饋中心");
ok("feedback page renders", await until(async () => (await text()).includes("反饋中心")));
const st = await invoke("feedback_status");
ok("backend configured (local)", st.ok?.configured && st.ok.base?.startsWith("http://127.0.0.1"), st);
await invoke("feedback_sign_out");

// the generic API bridge must refuse to create feedback / upload without the preview flow
const bypass = await invoke("feedback_api", { method: "POST", path: "/v1/feedback", query: null, body: { title: "x" } });
ok("bridge refuses direct create", !!bypass.err, bypass);
const bypass2 = await invoke("feedback_api", { method: "POST", path: "/v1/auth/dev", query: null, body: { login: "x", role: "maintainer" } });
ok("bridge refuses auth endpoints", !!bypass2.err, bypass2);

// ---- 2. sign in (local dev login through the UI) ----
await click("button", "以 GitHub 登入");
await until(async () => (await text()).includes("本機開發登入"));
await shot("feedback-signin");
await c.ev(`document.querySelector('.modal details').open = true`);
await setField(".modal details input", "alice");
await click(".modal details button", "登入");
ok("signed in as alice", await until(async () => (await text()).includes("alice")));

// ---- 3. compose ----
await click("button", "新增反饋");
await until(async () => !!(await c.ev("!!document.querySelector('.fb-form')")));
await setField(".fb-form select", "PikaraScienceStudio", 0);
await setField(".fb-form select", "bug", 1);
await setField(".fb-form input.fb-input", "E2E: export crashes when token is set");
await setField(".fb-form textarea", `Steps: set password=${SECRETS[1]} then export. Contact ${SECRETS[3]} from ${SECRETS[2]}.`);
const doc = await c.send("DOM.getDocument", { depth: -1 });
const input = await c.send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: ".fb-form input[type=file]" });
await c.send("DOM.setFileInputFiles", { nodeId: input.result.nodeId, files: [pngPath, logPath] });
ok("two attachments listed", await until(async () => (await c.ev("document.querySelectorAll('.fb-file').length")) === 2));
await shot("feedback-compose");
ok("nothing uploaded before preview", (await invoke("feedback_api", { method: "GET", path: "/v1/feedback", query: { mine: "1" }, body: null })).ok?.total === 0);

// ---- 4. preview + consent ----
await click("button", "預覽將上傳的內容");
ok("preview shown", await until(async () => (await text()).includes("確認將上傳的內容")));
const pv = await text();
ok("preview hides every secret", SECRETS.every((s) => !pv.includes(s)), SECRETS.filter((s) => pv.includes(s)));
ok("preview lists redactions", pv.includes("Token／密碼") && pv.includes("IP 位址") && pv.includes("電子郵件") && pv.includes("私鑰"));
ok("preview shows environment", pv.includes("CPU 架構") && pv.includes("CYW"));
ok("preview: image metadata removed", pv.includes("已移除 1 個中繼資料區塊"));
ok("preview: screenshot warning", pv.includes("圖片中的文字無法自動遮蔽"));
ok("confirm disabled before consent", (await disabled("確認並上傳")) === true);
await shot("feedback-preview");
await c.ev(`document.querySelector('.fb-agree input').click()`);
ok("confirm enabled after consent", (await disabled("確認並上傳")) === false);
await click("button", "確認並上傳");
ok("submitted, detail opens", await until(async () => (await text()).includes("處理紀錄") || (await text()).includes("留言（"), 10000));
const mine = (await invoke("feedback_api", { method: "GET", path: "/v1/feedback", query: { mine: "1" }, body: null })).ok;
ok("feedback stored", mine?.total === 1, mine);
const fid = mine?.items?.[0]?.id;
const full = (await invoke("feedback_api", { method: "GET", path: `/v1/feedback/${fid}`, query: null, body: null })).ok?.feedback;
ok("stored body redacted", full && SECRETS.every((s) => !full.body.includes(s)), full?.body);
ok("environment stored with consent", !!full?.environment?.arch, full?.environment);
ok("2 attachments stored", full?.attachments?.length === 2, full?.attachments);
const att = full?.attachments?.find((a) => a.content_type === "image/png");
const pngBack = att && (await invoke("feedback_attachment", { id: att.id })).ok;
ok("stored PNG has no metadata", pngBack && !Buffer.from(pngBack.dataBase64, "base64").includes(Buffer.from("e2e-secret-author")));
const logAtt = full?.attachments?.find((a) => a.content_type.startsWith("text/plain"));
const logBack = logAtt && (await invoke("feedback_attachment", { id: logAtt.id })).ok;
const logText = logBack ? Buffer.from(logBack.dataBase64, "base64").toString("utf8") : "";
ok("stored log redacted", logText.includes("[REDACTED:") && SECRETS.every((s) => !logText.includes(s)), logText);

// comment + vote as alice
await setField(".fb-reply textarea", "Also happens on 198.51.100.9");
await click(".fb-reply button", "送出留言");
ok("comment posted + redacted", await until(async () => (await text()).includes("Also happens on [REDACTED:ip]")));
await shot("feedback-detail-user");
ok("user sees no staff panel", !(await text()).includes("開發者管理"));
await closeModal();

// ---- 5. list: search / filter / vote ----
await sleep(400);
await setField(".fb-search input", "export crashes");
ok("search finds it", await until(async () => (await c.ev("document.querySelectorAll('.fb-row').length")) === 1));
await setField(".fb-filters select", "feature", 1);
ok("category filter excludes it", await until(async () => (await c.ev("document.querySelectorAll('.fb-row').length")) === 0));
await setField(".fb-filters select", "", 1);
await until(async () => (await c.ev("document.querySelectorAll('.fb-row').length")) === 1);
await sleep(800); // let the filter reload settle before voting
await c.ev(`document.querySelector('.fb-vote').click()`);
ok("vote counted", await until(async () => (await c.ev("document.querySelector('.fb-vote')?.innerText.trim()")) === "1"));
await shot("feedback-list");

// ---- 6. maintainer: status, official reply, task, release ----
await invoke("feedback_dev_sign_in", { login: "maint", role: "maintainer" });
await nav("首頁"); await sleep(300); await nav("反饋中心");
await until(async () => (await text()).includes("maint"));
await sleep(600);
await c.ev(`document.querySelector('.fb-row-main')?.click()`);
ok("maintainer sees staff panel", await until(async () => (await text()).includes("開發者管理")));
await click(".fb-staff button", "已確認");
ok("status → triaged", await until(async () => (await text()).includes("狀態：待處理 → 已確認")));
await setField(".fb-reply textarea", "Thanks, reproduced. Fix coming.");
await c.ev(`[...document.querySelectorAll('.fb-reply input[type=checkbox]')][0]?.click()`);
await click(".fb-reply button", "送出留言");
ok("official reply shown", await until(async () => (await text()).includes("開發者回覆")));
await c.ev(`[...document.querySelectorAll('.fb-staff input[type=checkbox]')][0]?.click()`);
await click(".fb-staff button", "轉換為 CYWS 開發任務");
ok("task created", await until(async () => (await text()).includes("已建立開發任務")));
await click(".fb-staff button", "處理中");
await until(async () => (await text()).includes("→ 處理中"));
await click(".fb-staff button", "已修復");
ok("status → fixed", await until(async () => (await text()).includes("已修復（待發布）")));
await shot("feedback-detail-maintainer");
await closeModal();
await sleep(400);
await click(".category-tab", "開發任務");
ok("task listed", await until(async () => (await c.ev("document.querySelectorAll('.list-row').length")) >= 1));
await c.ev(`document.querySelector('.list-row .fb-row-main')?.click()`);
ok("task shows untrusted banner", await until(async () => (await text()).includes("不可信任的使用者內容")));
const tasks = (await invoke("feedback_api", { method: "GET", path: "/v1/tasks", query: null, body: null })).ok?.items ?? [];
ok("task source marked untrusted", tasks[0]?.source?.untrusted === true && SECRETS.every((s) => !JSON.stringify(tasks[0]).includes(s)), tasks[0]?.source);
await shot("feedback-task");
await closeModal();
await sleep(300);
const number = full?.number;
await click("button", "記錄已發布的修復版本");
await until(async () => !!(await c.ev("!!document.querySelector('.modal .fb-form')")));
await until(async () => (await c.ev("document.querySelectorAll('.modal .fb-form select option').length")) > 1);
await setField(".modal .fb-form select", "PikaraScienceStudio");
ok("release form product selected", (await c.ev("document.querySelector('.modal .fb-form select').value")) === "PikaraScienceStudio");
await setField(".modal .fb-form input.fb-input", "v0.3.9", 0);
await setField(".modal .fb-form input.fb-input", "https://github.com/eddiesu9420minecraft-wq/PikaraScienceStudio/releases/tag/v0.3.9", 1);
await setField(".modal .fb-form input.fb-input", String(number), 2);
ok("release needs human confirmation", (await disabled("記錄並通知")) === true);
await c.ev(`document.querySelector('.modal .fb-form input[type=checkbox]').click()`);
await click(".modal button", "記錄並通知");
await sleep(800);
const after = (await invoke("feedback_api", { method: "GET", path: `/v1/feedback/${fid}`, query: null, body: null })).ok?.feedback;
ok("feedback released with fixed_in", after?.status === "released" && after?.fixed_in === "v0.3.9", { status: after?.status, fixed_in: after?.fixed_in });

// ---- 7. back to alice: notifications ----
await invoke("feedback_dev_sign_in", { login: "alice", role: "user" });
await nav("首頁"); await sleep(300); await nav("反饋中心");
await until(async () => (await text()).includes("alice"));
await click(".category-tab", "通知");
ok("alice notified of release", await until(async () => (await text()).includes("v0.3.9")));
ok("alice notified of developer reply", (await text()).includes("回覆") || (await text()).includes("reply"));
await shot("feedback-notifications");
const n = (await invoke("feedback_api", { method: "GET", path: "/v1/notifications", query: null, body: null })).ok;
ok("notification kinds", ["reply", "status", "released"].every((k) => n?.items?.some((i) => i.kind === k)), n?.items?.map((i) => i.kind));

// a plain user can't do staff things through the bridge either (server-side roles)
const deny = await invoke("feedback_api", { method: "PATCH", path: `/v1/feedback/${fid}`, query: null, body: { status: "closed" } });
ok("user cannot change status", !!deny.err && /403|forbidden|權限/i.test(deny.err), deny);

report.errors = report.errors.filter((e) => !/favicon/i.test(e));
ok("no console errors", report.errors.length === 0, report.errors);
const failed = report.checks.filter((x) => !x.pass).length;
console.log(JSON.stringify({ passed: report.checks.length - failed, failed, ...report }, null, 1));
process.exit(failed ? 1 : 0);
