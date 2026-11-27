import { useCallback, useState } from "react";
import { ACTIVE_STATES, ARCH_LABEL, OS_LABEL } from "./api";
import { PikaraLogo, RevealOverlay, splashBridge } from "./pikara-splash";
import { StoreProvider, useStore } from "./store";
import { Icon } from "./components/Icon";
import { ProductDetail } from "./components/Product";
import { AllAppsPage, HomePage, InstalledPage, UpdatesPage } from "./pages/AppsPages";
import { DownloadsPage, RuntimePage, SettingsPage } from "./pages/SystemPages";

export type Page = "home" | "apps" | "installed" | "updates" | "downloads" | "runtime" | "settings";

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: "home", label: "首頁", icon: "home" },
  { id: "apps", label: "所有應用程式", icon: "apps" },
  { id: "installed", label: "已安裝應用程式", icon: "installed" },
  { id: "updates", label: "更新管理", icon: "updates" },
  { id: "downloads", label: "下載管理", icon: "downloads" },
  { id: "runtime", label: "共用運行環境", icon: "runtime" },
];

function Shell() {
  const { products, jobs, info, loading, refresh, toasts, dismissToast } = useStore();
  const [page, setPage] = useState<Page>("home");
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = products.find((p) => p.id === detailId) ?? null;

  const counts: Partial<Record<Page, number>> = {
    updates: products.filter((p) => p.update).length,
    downloads: jobs.filter((j) => ACTIVE_STATES.includes(j.state)).length,
    installed: products.filter((p) => p.installed).length,
  };

  const go = (p: Page) => setPage(p);
  const search = (q: string) => {
    setQuery(q);
    if (q && page !== "apps" && page !== "installed") setPage("apps");
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <PikaraLogo size={30} />
          <div>
            <div className="brand-name">Create Your World.</div>
            <div className="brand-tag">Free Forever.</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <button key={n.id} className={`nav-item${page === n.id ? " active" : ""}`} onClick={() => go(n.id)}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
              {!!counts[n.id] && <span className={`nav-count${n.id === "updates" ? " gold" : ""}`}>{counts[n.id]}</span>}
            </button>
          ))}
        </nav>
        <div className="grow" />
        <button className={`nav-item${page === "settings" ? " active" : ""}`} onClick={() => go("settings")}>
          <Icon name="settings" />
          <span>設定</span>
        </button>
        <div className="sidebar-foot">— by pikara™</div>
      </aside>

      <div className="content">
        <header className="topbar">
          <div className="search">
            <Icon name="search" size={16} />
            <input placeholder="搜尋 Pikara 應用程式" value={query} onChange={(e) => search(e.target.value)} />
          </div>
          <div className="grow" />
          {info && (
            <span className="chip small">{OS_LABEL[info.platform.os] ?? info.platform.os} · {ARCH_LABEL[info.platform.arch] ?? info.platform.arch}{info.platform.rosetta ? "（Rosetta）" : ""}</span>
          )}
          <button className="icon-btn" title="重新整理版本資訊" disabled={loading} onClick={() => refresh(true)}>
            <Icon name="refresh" className={loading ? "spin" : undefined} />
          </button>
        </header>
        <main className="scroll">
          {page === "home" && <HomePage go={go} onOpen={setDetailId} />}
          {page === "apps" && <AllAppsPage query={query} onOpen={setDetailId} />}
          {page === "installed" && <InstalledPage query={query} onOpen={setDetailId} />}
          {page === "updates" && <UpdatesPage onOpen={setDetailId} />}
          {page === "downloads" && <DownloadsPage />}
          {page === "runtime" && <RuntimePage />}
          {page === "settings" && <SettingsPage />}
        </main>
      </div>

      {detail && <ProductDetail p={detail} onClose={() => setDetailId(null)} />}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}

export function App() {
  const onFirstLoad = useCallback(() => { splashBridge.mainReady().catch(() => {}); }, []);
  return (
    <StoreProvider onFirstLoad={onFirstLoad}>
      <Shell />
      <RevealOverlay />
    </StoreProvider>
  );
}
