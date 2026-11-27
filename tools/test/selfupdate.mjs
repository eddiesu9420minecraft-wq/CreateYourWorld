// Drives a REAL installed CYW (CDP on :9333) through the self-update scenarios.
// usage: node selfupdate.mjs <phase>
//   check            → check_self_update, print status
//   download-pause   → start download, pause at ≥40 %, print job (for tampering the .part)
//   resume-expect-fail → resume; expect security rejection
//   download-ready   → download fully; expect verified "ready"
//   apply            → apply_self_update (CYW exits, helper installs, relaunches)
//   status           → print self-update status + app version
const phase = process.argv[2];
const sleep = (n) => new Promise((r) => setTimeout(r, n));
async function main() {
  const t = (await (await fetch("http://127.0.0.1:9333/json")).json()).filter((x) => x.type === "page");
  for (const x of t) {
    const ws = new WebSocket(x.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const p = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); p.get(d.id)?.(d); };
    const ev = async (e) => {
      const i = ++id;
      const r = await new Promise((res) => { p.set(i, res); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: e, awaitPromise: true, returnByValue: true } })); });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
      return r.result?.result?.value;
    };
    if ((await ev("window.__TAURI_INTERNALS__.metadata.currentWindow.label")) !== "main") continue;
    const inv = (cmd, args = {}) => ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
    const job = async (jid) => (await inv("list_jobs")).find((j) => j.id === jid);
    const status = () => inv("self_update_status");
    const show = (o) => console.log(JSON.stringify(o, null, 1));

    if (phase === "check" || phase === "status") {
      if (phase === "check") await inv("check_self_update");
      const info = await inv("app_info");
      show({ appVersion: info.version, selfUpdate: await status() });
    } else if (phase === "download-pause") {
      const jid = await inv("download_self_update");
      let j;
      for (let i = 0; i < 2000; i++) { j = await job(jid); if (j.total && j.downloaded / j.total >= 0.4) break; await sleep(20); }
      await inv("pause_job", { id: jid });
      for (let i = 0; i < 200; i++) { j = await job(jid); if (j.state === "paused") break; await sleep(50); }
      show({ jid, state: j.state, downloaded: j.downloaded, total: j.total, asset: j.asset.name, tag: j.tag });
    } else if (phase === "resume-expect-fail") {
      const s0 = await status();
      const jid = s0.jobId;
      await inv("resume_job", { id: jid });
      let j;
      for (let i = 0; i < 1500; i++) { j = await job(jid); if (["completed", "failed"].includes(j.state)) break; await sleep(100); }
      show({ job: { state: j.state, resumedFrom: j.resumedFrom, error: j.error }, selfUpdate: await status() });
    } else if (phase === "download-ready") {
      const jid = await inv("download_self_update");
      let j;
      for (let i = 0; i < 3000; i++) { j = await job(jid); if (["completed", "failed"].includes(j.state)) break; await sleep(100); }
      show({ job: { state: j.state, error: j.error, verification: j.verification }, selfUpdate: await status() });
    } else if (phase === "apply") {
      inv("apply_self_update").catch(() => {});
      await sleep(1500);
      console.log("apply requested; CYW should now exit");
    }
    process.exit(0);
  }
  throw new Error("main window not found");
}
main().catch((e) => { console.error(e.message); process.exit(1); });
