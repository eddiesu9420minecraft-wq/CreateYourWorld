import { api, ACTIVE_STATES, formatBytes, formatDate, type ProductView } from "../api";
import { PikaraLogo } from "../pikara-splash";
import { useStore } from "../store";
import { ProductGlyph } from "../components/Icon";
import { ProductActions, ProductCard } from "../components/Product";
import { Badge, Button, Empty, PageHeader, VerifyBadges, VerifyDetails, useConfirm } from "../components/ui";
import type { Page } from "../App";
import { useState } from "react";
import { SelfUpdateCard } from "../components/SelfUpdateCard";

function matches(p: ProductView, q: string) {
  if (!q) return true;
  const s = q.toLowerCase();
  return [p.name, p.tagline, p.description].some((x) => x.toLowerCase().includes(s));
}

export function HomePage({ go, onOpen }: { go: (p: Page) => void; onOpen: (id: string) => void }) {
  const { products, jobs } = useStore();
  const installed = products.filter((p) => p.installed).length;
  const updates = products.filter((p) => p.update).length;
  const active = jobs.filter((j) => ACTIVE_STATES.includes(j.state)).length;
  const featured = products.filter((p) => p.status !== "in-development").slice(0, 3);
  const recent = products
    .flatMap((p) => p.releases.slice(0, 3).map((r) => ({ p, r })))
    .sort((a, b) => (b.r.publishedAt ?? "").localeCompare(a.r.publishedAt ?? ""))
    .slice(0, 6);

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-text">
          <div className="hero-eyebrow">pikara 全家桶 · 官方軟體中心</div>
          <h1 className="hero-title">Create Your World.</h1>
          <div className="hero-sub">Free Forever. <span className="muted">永遠免費 · 無訂閱 · 無付費解鎖 · 無強制廣告</span></div>
          <div className="row gap-8 mt-16">
            <Button kind="primary" onClick={() => go("apps")}>瀏覽所有應用程式</Button>
            {updates > 0 && <Button icon="updates" onClick={() => go("updates")}>{updates} 個可用更新</Button>}
          </div>
        </div>
        <PikaraLogo size={168} className="hero-logo" />
      </section>

      <div className="stats">
        <button className="stat" onClick={() => go("installed")}><span className="stat-num">{installed}</span><span className="muted">已安裝</span></button>
        <button className="stat" onClick={() => go("updates")}><span className="stat-num">{updates}</span><span className="muted">可更新</span></button>
        <button className="stat" onClick={() => go("downloads")}><span className="stat-num">{active}</span><span className="muted">下載中</span></button>
        <button className="stat" onClick={() => go("apps")}><span className="stat-num">{products.length}</span><span className="muted">產品</span></button>
      </div>

      <div className="section-title">精選應用程式</div>
      <div className="grid">
        {featured.map((p) => <ProductCard key={p.id} p={p} onOpen={() => onOpen(p.id)} />)}
        {featured.length === 0 && <Empty icon="apps" title="尚無已發布的產品" />}
      </div>

      {recent.length > 0 && (
        <>
          <div className="section-title">最新發布</div>
          <div className="card list">
            {recent.map(({ p, r }) => (
              <div className="list-row" key={`${p.id}-${r.tag}`}>
                <ProductGlyph glyph={p.glyph} size={34} />
                <div className="grow">
                  <div><b>{p.name}</b> <span className="muted">{r.tag}</span> <Badge tone={r.channel === "stable" ? "ok" : "warn"}>{r.channel}</Badge></div>
                  <div className="small muted">{formatDate(r.publishedAt)}{r.asset ? ` · ${formatBytes(r.asset.size)}` : " · 無此平台的檔案"}</div>
                </div>
                <Button kind="ghost" small onClick={() => onOpen(p.id)}>查看</Button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function AllAppsPage({ query, onOpen }: { query: string; onOpen: (id: string) => void }) {
  const { products } = useStore();
  const list = products.filter((p) => matches(p, query));
  return (
    <div className="page">
      <PageHeader title="所有應用程式" subtitle="版本與下載檔案均即時取自各產品的 GitHub Releases。" />
      {list.length === 0 ? <Empty icon="search" title="找不到符合的應用程式" /> : (
        <div className="grid">{list.map((p) => <ProductCard key={p.id} p={p} onOpen={() => onOpen(p.id)} />)}</div>
      )}
    </div>
  );
}

export function InstalledPage({ query, onOpen }: { query: string; onOpen: (id: string) => void }) {
  const { products, run, refresh } = useStore();
  const { ask, element } = useConfirm();
  const [expanded, setExpanded] = useState<string | null>(null);
  const list = products.filter((p) => p.installed && matches(p, query));

  const uninstall = async (p: ProductView) => {
    const ok = await ask(`解除安裝 ${p.name}？`, (
      <>將刪除 {p.name} 的所有已安裝版本（{p.installed!.versions.map((v) => v.tag).join("、")}）。此動作無法復原；應用程式自己的使用者資料不在此目錄內，不會被刪除。</>
    ), "解除安裝", true);
    if (ok) {
      await run(() => api.uninstall(p.id), `已解除安裝 ${p.name}`);
      await refresh(false);
    }
  };
  const rollback = async (p: ProductView) => {
    const tag = await run(() => api.rollback(p.id));
    if (tag) {
      await refresh(false);
      run(async () => undefined, `${p.name} 已回復至 ${tag}`);
    }
  };

  return (
    <div className="page">
      {element}
      <PageHeader title="已安裝應用程式" subtitle="每個版本安裝在獨立目錄；更新失敗不會影響目前版本。" />
      {list.length === 0 ? (
        <Empty icon="installed" title="尚未安裝任何應用程式">到「所有應用程式」安裝第一個 Pikara 軟體。</Empty>
      ) : (
        <div className="card list">
          {list.map((p) => {
            const inst = p.installed!;
            const cur = inst.versions.find((v) => v.tag === inst.current);
            const previous = inst.versions.filter((v) => v.tag !== inst.current);
            return (
              <div key={p.id} className="list-block">
                <div className="list-row">
                  <ProductGlyph glyph={p.glyph} size={44} />
                  <div className="grow">
                    <div className="row gap-8 wrap">
                      <b>{p.name}</b>
                      <span className="muted">{inst.current}</span>
                      {p.update && <Badge tone="gold">可更新至 {p.update.tag}</Badge>}
                    </div>
                    {cur && (
                      <div className="small muted">
                        安裝於 {formatDate(cur.installedAt)} · {cur.assetName} · {formatBytes(cur.size)}
                        {previous.length > 0 && ` · 保留舊版 ${previous.map((v) => v.tag).join("、")}`}
                      </div>
                    )}
                  </div>
                  <ProductActions p={p} />
                  {previous.length > 0 && <Button kind="ghost" icon="undo" onClick={() => rollback(p)} title="切換回保留的上一個版本">回復</Button>}
                  <Button kind="ghost" icon="folder" onClick={() => run(() => api.openFolder(p.id))} title="開啟安裝位置" />
                  <Button kind="ghost" icon="shield" onClick={() => setExpanded(expanded === p.id ? null : p.id)} title="驗證資訊" />
                  <Button kind="ghost" icon="trash" onClick={() => uninstall(p)} title="解除安裝" />
                </div>
                {expanded === p.id && cur && (
                  <div className="list-extra">
                    <VerifyBadges report={cur.verification} />
                    <VerifyDetails report={cur.verification} />
                    <div className="small muted mono">{cur.dir}</div>
                    <Button kind="ghost" small onClick={() => onOpen(p.id)}>所有版本</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function UpdatesPage({ onOpen }: { onOpen: (id: string) => void }) {
  const { products, refresh, loading, lastRefresh, activeJobFor, install } = useStore();
  const list = products.filter((p) => p.update);
  const updateAll = async () => {
    for (const p of list) if (!activeJobFor(p.id)) await install(p.id, p.name, p.update!.tag);
  };
  return (
    <div className="page">
      <PageHeader
        title="更新管理"
        subtitle={lastRefresh ? `上次檢查：${new Date(lastRefresh).toLocaleTimeString("zh-TW")}` : undefined}
        actions={<>
          <Button icon="refresh" disabled={loading} onClick={() => refresh(true)}>{loading ? "檢查中…" : "立即檢查"}</Button>
          {list.length > 1 && <Button kind="primary" onClick={updateAll}>全部更新</Button>}
        </>}
      />
      <SelfUpdateCard />
      <div className="section-title">應用程式</div>
      {list.length === 0 ? (
        <Empty icon="check" title="所有應用程式都是最新版本">更新依各產品在「設定」中選擇的頻道判斷。</Empty>
      ) : (
        <div className="card list">
          {list.map((p) => (
            <div key={p.id} className="list-row">
              <ProductGlyph glyph={p.glyph} size={44} />
              <div className="grow">
                <div><b>{p.name}</b> <span className="muted">{p.installed!.current} → </span><b className="gold">{p.update!.tag}</b></div>
                <div className="small muted">{formatDate(p.update!.publishedAt)} · {p.update!.asset && formatBytes(p.update!.asset.size)} · {p.channel} 頻道</div>
                {p.pendingUpdate && <div className="small gold">正在執行中，會在你關閉它之後自動更新（不會強制關閉）。</div>}
              </div>
              <Button kind="ghost" onClick={() => onOpen(p.id)}>更新說明</Button>
              <ProductActions p={p} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
