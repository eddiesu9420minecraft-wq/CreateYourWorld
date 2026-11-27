import { useEffect, useState } from "react";
import { api, errText, formatDate, type SelfUpdateStatus } from "../api";
import { PikaraLogo } from "@pikara/splash";
import { useStore } from "../store";
import { Badge, Button, JobProgress } from "./ui";

/** Create Your World. updating itself (signed update.json → verified download → helper). */
export function SelfUpdateCard() {
  const { jobs, run } = useStore();
  const [s, setS] = useState<SelfUpdateStatus | null>(null);
  const [notes, setNotes] = useState(false);

  useEffect(() => {
    api.selfUpdateStatus().then(setS).catch(() => {});
    const un = api.onSelfUpdate(setS);
    return () => { un.then((f) => f()); };
  }, []);
  if (!s) return null;

  const job = s.jobId != null ? jobs.find((j) => j.id === s.jobId) : undefined;
  const check = () => run(async () => setS(await api.checkSelfUpdate()));

  let badge = null;
  let line = "";
  switch (s.state) {
    case "unsupported": badge = <Badge>無法自動更新</Badge>; line = s.unsupportedReason ?? ""; break;
    case "checking": badge = <Badge>檢查中…</Badge>; break;
    case "up-to-date": badge = <Badge tone="ok">已是最新版本</Badge>; line = s.checkedAt ? `上次檢查：${formatDate(s.checkedAt)} ${new Date(s.checkedAt * 1000).toLocaleTimeString("zh-TW")}` : ""; break;
    case "available": badge = <Badge tone="gold">有新版本 {s.latest}</Badge>; line = "更新資訊的數位簽章已驗證。"; break;
    case "downloading": badge = <Badge tone="gold">下載中</Badge>; break;
    case "ready": badge = <Badge tone="ok">已驗證，等待安裝</Badge>; line = `${s.latest} 的 SHA-256 與發布簽章皆已通過驗證。`; break;
    case "error": badge = <Badge tone={s.securityAlert ? "danger" : "warn"}>{s.securityAlert ? "安全檢查未通過" : "無法檢查更新"}</Badge>; line = s.error ?? ""; break;
    default: badge = <Badge>尚未檢查</Badge>;
  }

  return (
    <div className="card self-update">
      <div className="list-row">
        <PikaraLogo size={40} />
        <div className="grow">
          <div className="row gap-8 wrap"><b>Create Your World.</b><span className="muted">v{s.current}</span>{badge}</div>
          {line && <div className={`small ${s.state === "error" && s.securityAlert ? "danger" : "muted"}`}>{line}</div>}
          {s.state === "error" && s.securityAlert && <div className="small muted">目前版本不受影響，可繼續正常使用。</div>}
        </div>
        <div className="row gap-8">
          {s.notes && (s.state === "available" || s.state === "ready") && <Button kind="ghost" onClick={() => setNotes(!notes)}>更新日誌</Button>}
          {s.state !== "unsupported" && s.state !== "downloading" && s.state !== "checking" && <Button kind="ghost" icon="refresh" onClick={check}>檢查更新</Button>}
          {s.state === "available" && <Button kind="primary" onClick={() => run(() => api.downloadSelfUpdate())}>下載並驗證</Button>}
          {s.state === "ready" && <Button kind="primary" onClick={() => run(() => api.applySelfUpdate())}>立即更新並重新啟動</Button>}
        </div>
      </div>
      {job && s.state === "downloading" && <div className="list-extra"><JobProgress job={job} /></div>}
      {notes && s.notes && <div className="list-extra"><pre className="notes">{s.notes}</pre></div>}
    </div>
  );
}

export function useNetworkStatusText() {
  const [t, setT] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    api.networkStatus()
      .then((n) => setT(n.ok ? { ok: true, text: `DNS over HTTPS（${n.provider}）→ ${n.addresses.join("、")}` } : { ok: false, text: n.error ?? "失敗" }))
      .catch((e) => setT({ ok: false, text: errText(e) }));
  }, []);
  return t;
}
