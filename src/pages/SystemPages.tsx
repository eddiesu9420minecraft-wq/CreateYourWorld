import { useEffect, useState } from "react";
import { api, ACTIVE_STATES, CHANNEL_LABEL, errText, formatBytes, formatDate, type ApiStatus, type Channel, type HardwareReport, type JobInfo } from "../api";
import { useStore } from "../store";
import { Icon } from "../components/Icon";
import { Badge, Button, Empty, JobProgress, PageHeader, VerifyDetails } from "../components/ui";
import { useNetworkStatusText } from "../components/SelfUpdateCard";
import type { UpdateMode } from "../api";

const MODE_LABEL: Record<UpdateMode, string> = { auto: "自動更新", notify: "僅通知", manual: "手動更新" };

function JobRow({ job }: { job: JobInfo }) {
  const { run } = useStore();
  const [open, setOpen] = useState(false);
  const active = ACTIVE_STATES.includes(job.state);
  return (
    <div className="list-block">
      <div className="list-row">
        <div className={`job-icon job-${job.state}`}><Icon name={job.state === "completed" ? "check" : job.state === "failed" ? "alert" : "downloads"} /></div>
        <div className="grow">
          <div className="row gap-8 wrap">
            <b>{job.productName}</b>
            <span className="muted">{job.tag}</span>
            <Badge>{job.purpose === "update" ? "更新" : "安裝"}</Badge>
            {job.resumedFrom > 0 && job.state === "downloading" && <Badge tone="gold">續傳自 {formatBytes(job.resumedFrom)}</Badge>}
          </div>
          <div className="small muted">{job.asset.name} · {formatBytes(job.total)} · {formatDate(job.createdAt)}</div>
          {active ? <JobProgress job={job} /> : (
            <div className={`small ${job.state === "failed" ? "danger" : "muted"}`}>
              {job.state === "completed" ? "已下載、驗證並安裝" : job.state === "canceled" ? "已取消" : job.error}
            </div>
          )}
        </div>
        <div className="row gap-6">
          {job.state === "downloading" && <Button kind="ghost" icon="pause" onClick={() => run(() => api.pauseJob(job.id))}>暫停</Button>}
          {job.state === "paused" && <Button icon="play" onClick={() => run(() => api.resumeJob(job.id))}>繼續</Button>}
          {job.state === "failed" && <Button icon="retry" onClick={() => run(() => api.resumeJob(job.id))}>重試</Button>}
          {["queued", "downloading", "paused", "failed"].includes(job.state) && (
            <Button kind="ghost" icon="close" onClick={() => run(() => api.cancelJob(job.id))} title="取消並刪除暫存檔" />
          )}
          {job.verification && <Button kind="ghost" icon="shield" onClick={() => setOpen(!open)} title="驗證結果" />}
        </div>
      </div>
      {open && job.verification && <div className="list-extra"><VerifyDetails report={job.verification} /></div>}
    </div>
  );
}

export function DownloadsPage() {
  const { jobs, run, reloadJobs } = useStore();
  const sorted = jobs.slice().sort((a, b) => {
    const aa = ACTIVE_STATES.includes(a.state) ? 0 : 1;
    const bb = ACTIVE_STATES.includes(b.state) ? 0 : 1;
    return aa - bb || b.id - a.id;
  });
  const finished = jobs.some((j) => !ACTIVE_STATES.includes(j.state));
  return (
    <div className="page">
      <PageHeader
        title="下載管理"
        subtitle="支援斷點續傳；完成後自動驗證 SHA-256 與簽章，再進行安裝。"
        actions={finished && <Button kind="ghost" onClick={() => run(() => api.clearFinished()).then(reloadJobs)}>清除已結束項目</Button>}
      />
      {sorted.length === 0 ? <Empty icon="downloads" title="下載佇列是空的" /> : (
        <div className="card list">{sorted.map((j) => <JobRow key={j.id} job={j} />)}</div>
      )}
    </div>
  );
}

const PLANNED_RUNTIMES = [
  { name: "Python", note: "各版本獨立 venv，依應用程式鎖定版本" },
  { name: "FFmpeg", note: "影音轉檔與擷取" },
  { name: "Whisper", note: "語音辨識（CUDA / Metal / CPU 版本）" },
  { name: "llama.cpp", note: "本機 LLM 推論（依偵測到的後端選擇建置）" },
  { name: "AI 模型", note: "以內容雜湊去重、多個應用程式共用" },
];

export function RuntimePage() {
  const { info } = useStore();
  const [hw, setHw] = useState<HardwareReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.hardware().then(setHw).catch((e) => setError(errText(e))); }, []);

  return (
    <div className="page">
      <PageHeader title="共用運行環境" subtitle="統一管理各 Pikara 軟體共用的運行環境與 AI 模型，避免重複下載。" />
      <div className="section-title">運算後端偵測</div>
      {error && <div className="callout warn">{error}</div>}
      {!hw && !error && <div className="muted">正在偵測硬體…</div>}
      {hw && (
        <>
          <div className="grid grid-4">
            {hw.backends.map((b) => (
              <div key={b.id} className={`card backend${b.available ? " on" : ""}`}>
                <div className="row space">
                  <b>{b.name}</b>
                  {b.id === hw.recommended ? <Badge tone="gold">建議</Badge> : b.available ? <Badge tone="ok">可用</Badge> : <Badge>不可用</Badge>}
                </div>
                <div className="small muted mt-8">{b.detail}</div>
              </div>
            ))}
          </div>
          {hw.gpus.length > 0 && (
            <div className="card list mt-16">
              {hw.gpus.map((g, i) => (
                <div key={i} className="list-row">
                  <Icon name="chip" />
                  <div className="grow"><b>{g.name}</b><div className="small muted">{g.vendor}{g.driver && ` · 驅動程式 ${g.driver}`}</div></div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="section-title">共用運行環境 <Badge tone="warn">P2 開發中</Badge></div>
      <div className="callout small">
        Runtime Manager 尚未開放安裝。設計：每個運行環境依「名稱 / 版本 / 後端」安裝在獨立目錄
        （<span className="mono">{info?.paths.runtimes ?? "runtimes"}</span>），各應用程式以清單鎖定所需版本；
        更新其中一款軟體只會新增版本，不會覆蓋其他軟體正在使用的版本。
      </div>
      <div className="card list">
        {PLANNED_RUNTIMES.map((r) => (
          <div key={r.name} className="list-row">
            <Icon name="runtime" />
            <div className="grow"><b>{r.name}</b><div className="small muted">{r.note}</div></div>
            <Badge>開發中</Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { settings, setSettings, products, info, run, refresh } = useStore();
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const net = useNetworkStatusText();
  useEffect(() => { api.githubStatus().then(setStatus).catch(() => {}); }, []);
  if (!settings) return null;

  const update = (patch: Partial<typeof settings>) => setSettings({ ...settings, ...patch });
  const setProductChannel = async (id: string, c: Channel) => {
    await setSettings({ ...settings, channels: { ...settings.channels, [id]: c } });
    await refresh(false);
  };
  const rate = status?.rate;

  return (
    <div className="page">
      <PageHeader title="設定" />

      <div className="section-title">自動更新</div>
      <div className="card form">
        <div className="form-row">
          <div><b>Create Your World. 本身</b><div className="small muted">自動：下載並驗證後，在你結束 CYW 時安裝。也可以在「更新管理」立即更新並重新啟動。</div></div>
          <select value={settings.selfUpdateMode} onChange={(e) => update({ selfUpdateMode: e.target.value as UpdateMode })}>
            {(Object.keys(MODE_LABEL) as UpdateMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select>
        </div>
        <div className="form-row">
          <div><b>已安裝的應用程式</b><div className="small muted">啟動時檢查一次，之後每 60 分鐘檢查一次。正在執行的應用程式不會被關閉，會等你關閉後再更新。</div></div>
          <select value={settings.appsUpdateMode} onChange={(e) => update({ appsUpdateMode: e.target.value as UpdateMode })}>
            {(Object.keys(MODE_LABEL) as UpdateMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select>
        </div>
      </div>

      <div className="section-title">更新頻道</div>
      <div className="card form">
        <div className="form-row">
          <div><b>預設頻道</b><div className="small muted">Stable 只收正式版；Beta 另收測試版；Alpha 收到所有預先發布版本。</div></div>
          <select value={settings.defaultChannel} onChange={(e) => update({ defaultChannel: e.target.value as Channel }).then(() => refresh(false))}>
            {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
          </select>
        </div>
        {products.filter((p) => p.repo).map((p) => (
          <div className="form-row" key={p.id}>
            <div><b>{p.name}</b></div>
            <select value={settings.channels[p.id] ?? settings.defaultChannel} onChange={(e) => setProductChannel(p.id, e.target.value as Channel)}>
              {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
            </select>
          </div>
        ))}
      </div>

      <div className="section-title">下載與安裝</div>
      <div className="card form">
        <div className="form-row">
          <div><b>同時下載數量</b></div>
          <select value={settings.maxConcurrentDownloads} onChange={(e) => update({ maxConcurrentDownloads: Number(e.target.value) })}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="form-row">
          <div><b>保留舊版本數量</b><div className="small muted">用於「回復」；0 表示更新成功後立即刪除舊版。</div></div>
          <select value={settings.keepPreviousVersions} onChange={(e) => update({ keepPreviousVersions: Number(e.target.value) })}>
            {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="form-row">
          <div><b>安裝完成後自動開啟</b></div>
          <input type="checkbox" className="switch" checked={settings.launchAfterInstall} onChange={(e) => update({ launchAfterInstall: e.target.checked })} />
        </div>
      </div>

      <div className="section-title">Pikara Secure Network</div>
      <div className="card form">
        <div className="form-row">
          <div>
            <b>安全 DNS 解析</b>
            <div className={`small ${net && !net.ok ? "danger" : "muted"}`}>{net ? net.text : "檢查中…"}</div>
            <div className="small muted">更新與下載只透過 DNS over HTTPS（Cloudflare，備援 Google）解析，只使用 HTTPS 並嚴格驗證憑證，不使用也不修改系統 DNS 設定。</div>
          </div>
        </div>
      </div>

      <div className="section-title">GitHub API</div>
      <div className="card form">
        <div className="form-row">
          <div>
            <b>請求額度</b>
            <div className="small muted">
              {rate?.remaining != null ? `剩餘 ${rate.remaining} / ${rate.limit}，${rate.reset ? `於 ${new Date(rate.reset * 1000).toLocaleTimeString("zh-TW")} 重置` : ""}` : "尚未向 GitHub 發出請求（使用快取）"}
            </div>
            <div className="small muted">
              {status?.tokenSource ? `已使用 Token（${status.tokenSource}）` : "未驗證：每小時 60 次。可設定環境變數 GITHUB_TOKEN 提高至 5000 次。"}
              回應會快取 10 分鐘，並以 ETag 條件請求避免重複計次。
            </div>
          </div>
          <Button onClick={() => run(() => api.clearApiCache(), "已清除 API 快取")}>清除快取</Button>
        </div>
      </div>

      <div className="section-title">儲存位置</div>
      <div className="card form">
        {info && (["apps", "downloads", "runtimes", "cache"] as const).map((k) => (
          <div className="form-row" key={k}>
            <div><b>{{ apps: "應用程式", downloads: "下載暫存", runtimes: "運行環境", cache: "快取" }[k]}</b></div>
            <span className="mono small muted">{info.paths[k]}</span>
          </div>
        ))}
        <div className="form-row"><div /><Button icon="folder" onClick={() => run(() => api.openDataDir())}>開啟資料夾</Button></div>
      </div>

      <div className="section-title">關於</div>
      <div className="card about">
        <div><b>Create Your World.</b> {info && <span className="muted">v{info.version} · {info.platform.os} {info.platform.arch}</span>}</div>
        <div className="gold">Free Forever.</div>
        <div className="muted small">永遠免費、無訂閱、無付費解鎖、無強制廣告。— by pikara™</div>
      </div>
    </div>
  );
}
