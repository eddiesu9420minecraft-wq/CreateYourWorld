import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { splashBridge } from "./splash";
import { api, errText, ACTIVE_STATES, type AppInfo, type JobInfo, type ProductView, type Settings } from "./api";

interface Toast { id: number; kind: "error" | "info" | "ok"; text: string }

interface Store {
  info: AppInfo | null;
  products: ProductView[];
  jobs: JobInfo[];
  settings: Settings | null;
  loading: boolean;
  lastRefresh: number | null;
  toasts: Toast[];
  refresh: (force?: boolean) => Promise<void>;
  reloadJobs: () => Promise<void>;
  /** Install / update a product; switches instantly when that version is already on disk. */
  install: (productId: string, name: string, tag?: string) => Promise<void>;
  setSettings: (s: Settings) => Promise<void>;
  activeJobFor: (productId: string) => JobInfo | undefined;
  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
  /** Runs an action, surfacing failures as a toast. */
  run: <T>(fn: () => Promise<T>, ok?: string) => Promise<T | undefined>;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("StoreProvider missing");
  return s;
}

export function StoreProvider({ children, onFirstLoad }: { children: ReactNode; onFirstLoad: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [products, setProducts] = useState<ProductView[]>([]);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const firstLoad = useRef(false);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    try {
      setProducts(await api.products(force));
      setLastRefresh(Date.now());
    } catch (e) {
      toast("error", errText(e));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const reloadJobs = useCallback(async () => { setJobs(await api.jobs()); }, []);

  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string) => {
    try {
      const r = await fn();
      if (ok) toast("ok", ok);
      return r;
    } catch (e) {
      toast("error", errText(e));
      return undefined;
    }
  }, [toast]);

  const install = useCallback(async (productId: string, name: string, tag?: string) => {
    const r = await run(() => api.install(productId, tag));
    if (r?.deferred) toast("info", `${name} 正在執行中：會在你關閉它之後自動更新，不會強制關閉。`);
    else if (r?.switchedTo) toast("ok", `${name} 已切換至保留的 ${r.switchedTo}`);
    else if (r?.jobId != null) toast("info", `已加入下載佇列：${name}${tag ? ` ${tag}` : ""}`);
  }, [run, toast]);

  const setSettings = useCallback(async (s: Settings) => {
    const saved = await run(() => api.saveSettings(s));
    if (saved) setSettingsState(saved);
  }, [run]);

  useEffect(() => {
    let alive = true;
    const unsubs = [
      api.onJob((j) => setJobs((list) => {
        const i = list.findIndex((x) => x.id === j.id);
        if (i < 0) return [...list, j];
        const next = list.slice();
        next[i] = j;
        return next;
      })),
      api.onAppsChanged(() => { void refresh(false); }),
    ];
    (async () => {
      // Load everything before the window is revealed, so the first frame shows real data.
      await splashBridge.waitReady();
      const [i, p, j, s] = await Promise.all([api.appInfo(), api.products(false), api.jobs(), api.settings()]);
      if (!alive) return;
      setInfo(i);
      setProducts(p);
      setJobs(j);
      setSettingsState(s);
      setLastRefresh(Date.now());
      setLoading(false);
    })().catch((e) => {
      setLoading(false);
      toast("error", errText(e));
    });
    return () => {
      alive = false;
      unsubs.forEach((u) => u.then((f) => f()));
    };
  }, [refresh, toast]);

  // Runs synchronously right after the real UI is committed to the DOM. Timers and rAF are
  // throttled while the main window is still hidden, so they must not gate the hand-off.
  useLayoutEffect(() => {
    if (!loading && !firstLoad.current) {
      firstLoad.current = true;
      onFirstLoad();
    }
  }, [loading, onFirstLoad]);

  const activeJobFor = useCallback(
    (productId: string) => jobs.find((j) => j.productId === productId && ACTIVE_STATES.includes(j.state)),
    [jobs],
  );

  const value = useMemo<Store>(() => ({
    info, products, jobs, settings, loading, lastRefresh, toasts,
    refresh, reloadJobs, install, setSettings, activeJobFor, toast, dismissToast, run,
  }), [info, products, jobs, settings, loading, lastRefresh, toasts, refresh, reloadJobs, install, setSettings, activeJobFor, toast, dismissToast, run]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
