import { useState } from "react";
import { api, ARCH_LABEL, CHANNEL_LABEL, formatBytes, formatDate, OS_LABEL, type Channel, type ProductView, type ReleaseView } from "../api";
import { useStore } from "../store";
import { ProductGlyph } from "./Icon";
import { Badge, Button, JobProgress, Modal } from "./ui";

export function statusBadge(p: ProductView) {
  if (p.status === "in-development") return <Badge tone="warn">開發中</Badge>;
  if (p.status === "no-platform-build") return <Badge>此平台尚無版本</Badge>;
  if (p.status === "offline") return <Badge tone="danger">無法取得版本</Badge>;
  if (p.pendingUpdate) return <Badge tone="gold">關閉後更新</Badge>;
  if (p.update) return <Badge tone="gold">可更新</Badge>;
  if (p.installed) return <Badge tone="ok">已安裝</Badge>;
  return null;
}

/** The primary action for a product, reflecting its real state. */
export function ProductActions({ p, onDetails }: { p: ProductView; onDetails?: () => void }) {
  const { activeJobFor, run, install, refresh, toast } = useStore();
  const job = activeJobFor(p.id);
  const togglePath = async (enabled: boolean) => {
    const problem = await run(() => api.setOnPath(p.id, enabled),
      enabled ? `已把 ${p.cli} 加入使用者 PATH；請開新的終端機視窗後執行 ${p.cli?.replace(/\.exe$/, "")} --version` : `已從使用者 PATH 移除 ${p.cli}`);
    if (problem) toast("error", problem);
    await refresh(false);
  };
  if (job) {
    return (
      <div className="product-job">
        <JobProgress job={job} compact />
      </div>
    );
  }
  const actions = [];
  if (p.installed && p.cli) {
    // developer tool: no window to open; offer PATH and the install folder instead
    actions.push(p.onPath ? (
      <Button key="path" icon="terminal" onClick={() => togglePath(false)}>從 PATH 移除</Button>
    ) : (
      <Button key="path" kind="primary" icon="terminal" onClick={() => togglePath(true)}>加入 PATH</Button>
    ));
    actions.push(<Button key="dir" kind="ghost" icon="folder" onClick={() => run(() => api.openFolder(p.id))}>開啟資料夾</Button>);
    if (p.update) {
      actions.push(
        <Button key="upd" icon="updates" onClick={() => install(p.id, p.name, p.update!.tag)}>
          更新至 {p.update.tag}
        </Button>,
      );
    }
  } else if (p.installed) {
    actions.push(<Button key="open" kind="primary" icon="play" onClick={() => run(() => api.launch(p.id))}>開啟</Button>);
    if (p.update) {
      actions.push(
        <Button key="upd" icon="updates" onClick={() => install(p.id, p.name, p.update!.tag)}>
          更新至 {p.update.tag}
        </Button>,
      );
    }
  } else if (p.status === "available" && p.latest) {
    actions.push(
      <Button key="inst" kind="primary" onClick={() => install(p.id, p.name, p.latest!.tag)}>
        安裝 {p.latest.tag}
      </Button>,
    );
  } else {
    actions.push(<Button key="dis" disabled>{p.status === "in-development" ? "開發中" : "無法安裝"}</Button>);
  }
  if (onDetails) actions.push(<Button key="det" kind="ghost" onClick={onDetails}>詳細資料</Button>);
  return <div className="row gap-8 wrap">{actions}</div>;
}

export function ProductCard({ p, onOpen }: { p: ProductView; onOpen: () => void }) {
  return (
    <div className="card product-card">
      <div className="row gap-14 top">
        <ProductGlyph glyph={p.glyph} />
        <div className="grow">
          <div className="row gap-8 wrap">
            <div className="product-name">{p.name}</div>
            {statusBadge(p)}
          </div>
          <div className="muted small">{p.tagline}</div>
        </div>
      </div>
      <p className="product-desc">{p.description}</p>
      {p.cli && p.installed && (
        <div className="small muted">
          命令列工具 <span className="mono">{p.cli}</span>{p.onPath ? " · 已在 PATH" : " · 未加入 PATH"}
          {p.pathProblem && <div className="callout warn small">{p.pathProblem}</div>}
        </div>
      )}
      <div className="product-meta small muted">
        {p.latest ? (
          <>最新 {p.latest.tag} · {formatDate(p.latest.publishedAt)}{p.latest.asset && ` · ${formatBytes(p.latest.asset.size)}`}</>
        ) : p.status === "no-platform-build" ? (
          <>已有發布版本，但尚未提供此平台的檔案</>
        ) : p.status === "offline" ? (
          <>{p.warning}</>
        ) : (
          <>尚未發布任何版本</>
        )}
        {p.installed && <> · 已安裝 {p.installed.current}</>}
      </div>
      <ProductActions p={p} onDetails={onOpen} />
    </div>
  );
}

function ReleaseRow({ p, r }: { p: ProductView; r: ReleaseView }) {
  const { run, activeJobFor, install } = useStore();
  const [open, setOpen] = useState(false);
  const installed = p.installed?.versions.some((v) => v.tag === r.tag);
  const busy = !!activeJobFor(p.id);
  return (
    <div className="release">
      <div className="row space gap-12">
        <div className="grow">
          <div className="row gap-8 wrap">
            <b>{r.name}</b>
            <Badge tone={r.channel === "stable" ? "ok" : r.channel === "beta" ? "gold" : "warn"}>{r.channel}</Badge>
            {p.installed?.current === r.tag && <Badge tone="ok">目前使用中</Badge>}
            {installed && p.installed?.current !== r.tag && <Badge>已保留</Badge>}
          </div>
          <div className="small muted">
            {r.tag} · {formatDate(r.publishedAt)} ·{" "}
            {r.asset ? `${r.asset.name}（${formatBytes(r.asset.size)}）` : "無此平台的檔案"}
          </div>
        </div>
        <div className="row gap-8">
          {r.notes && <Button kind="ghost" small onClick={() => setOpen(!open)}>{open ? "收合" : "更新說明"}</Button>}
          <Button kind="ghost" small icon="github" onClick={() => run(() => api.openReleasePage(r.htmlUrl))} title="在 GitHub 上檢視" />
          {installed && p.installed?.current !== r.tag && (
            <Button small disabled={busy} onClick={() => install(p.id, p.name, r.tag)}>切換至此版本</Button>
          )}
          {r.asset && !installed && (
            <Button small disabled={busy} onClick={() => install(p.id, p.name, r.tag)}>安裝此版本</Button>
          )}
        </div>
      </div>
      {open && <pre className="notes">{r.notes}</pre>}
    </div>
  );
}

export function ProductDetail({ p, onClose }: { p: ProductView; onClose: () => void }) {
  const { info, run, refresh } = useStore();
  const setChannel = async (c: Channel) => {
    await run(() => api.setChannel(p.id, c));
    await refresh(false);
  };
  return (
    <Modal wide onClose={onClose} title={
      <div className="row gap-12">
        <ProductGlyph glyph={p.glyph} size={40} />
        <div>
          <div>{p.name}</div>
          <div className="small muted">{p.tagline}</div>
        </div>
      </div>
    }>
      <p>{p.description}</p>
      <div className="row gap-12 wrap detail-bar">
        {statusBadge(p)}
        {p.repo && <span className="small muted mono">github.com/{p.repo}</span>}
        {info && <span className="small muted">目前平台：{OS_LABEL[info.platform.os] ?? info.platform.os} {ARCH_LABEL[info.platform.arch] ?? info.platform.arch}</span>}
        <div className="grow" />
        <label className="small muted row gap-6">
          更新頻道
          <select value={p.channel} onChange={(e) => setChannel(e.target.value as Channel)}>
            {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
          </select>
        </label>
      </div>
      {p.warning && <div className="callout warn small">{p.warning}</div>}
      {p.cli && (
        <div className="callout small">
          <b>命令列工具</b>：安裝後沒有視窗，請在終端機執行 <span className="mono">{p.cli.replace(/\.exe$/, "")}</span>。
          「加入 PATH」會把目前版本複製到 Create Your World 的 bin 資料夾，並把這個資料夾加入<b>使用者</b> PATH（不需要系統管理員權限）；
          更新、切換版本或回復時自動跟著更新，解除安裝或移除時一併清除。加入後請開新的終端機視窗。
          {p.pathProblem && <div className="callout warn small">{p.pathProblem}</div>}
        </div>
      )}
      <div className="section-title">發布版本</div>
      {p.releases.length === 0 ? (
        <div className="muted small">{p.repo ? "此頻道沒有發布版本。" : "此產品仍在開發中，尚未建立發布版本。"}</div>
      ) : (
        <div className="releases">{p.releases.map((r) => <ReleaseRow key={r.tag} p={p} r={r} />)}</div>
      )}
      <div className="row gap-8 mt-16"><ProductActions p={p} /></div>
    </Modal>
  );
}
