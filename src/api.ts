import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Channel = "stable" | "beta" | "alpha";
export type InstallKind = "portable" | "nsis" | "dmg" | "app-tar" | "app-image" | "archive";
export type CheckStatus = "passed" | "failed" | "not-available" | "not-configured";

export interface Check { status: CheckStatus; detail: string }
export interface VerifyReport { sha256: string; githubDigest: Check; checksumFile: Check; signature: Check }

export interface SelectedAsset {
  name: string; size: number; url: string; digest: string | null; kind: InstallKind; launch: string | null;
}

export interface ReleaseView {
  tag: string; name: string; channel: Channel; publishedAt: string | null; htmlUrl: string; notes: string;
  asset: SelectedAsset | null;
}

export interface InstalledVersion {
  tag: string; dir: string; launch: string; kind: InstallKind; assetName: string; size: number;
  verification: VerifyReport; installedAt: number;
}
export interface InstalledApp { productId: string; current: string; versions: InstalledVersion[] }

export type ProductStatus = "available" | "in-development" | "no-platform-build" | "offline";

export interface ProductView {
  id: string; name: string; tagline: string; description: string; glyph: string | null; repo: string | null;
  status: ProductStatus; channel: Channel; releases: ReleaseView[]; latest: ReleaseView | null;
  installed: InstalledApp | null; update: ReleaseView | null; warning: string | null;
  fetchedAt: number | null; source: string | null; signing: boolean;
  pendingUpdate: boolean; running: boolean;
}

export type JobState = "queued" | "downloading" | "paused" | "verifying" | "installing" | "completed" | "failed" | "canceled";

export interface JobInfo {
  id: number; productId: string; productName: string; tag: string; purpose: "install" | "update";
  asset: SelectedAsset; sumsUrl: string | null; sigUrl: string | null; state: JobState;
  downloaded: number; total: number; speed: number; resumedFrom: number; error: string | null;
  verification: VerifyReport | null; createdAt: number; finishedAt: number | null;
}

export interface InstallOutcome { jobId: number | null; switchedTo: string | null; deferred: boolean }

export type UpdateMode = "auto" | "notify" | "manual";
export type UiMotion = "system" | "on" | "off";

export interface Settings {
  maxConcurrentDownloads: number; keepPreviousVersions: number; launchAfterInstall: boolean;
  defaultChannel: Channel; channels: Record<string, Channel>;
  selfUpdateMode: UpdateMode; appsUpdateMode: UpdateMode;
  uiMotion: UiMotion;
}

export interface SelfUpdateStatus {
  current: string;
  state: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error" | "unsupported";
  latest: string | null; notes: string | null; error: string | null; securityAlert: boolean;
  checkedAt: number | null; jobId: number | null; unsupportedReason: string | null;
}

export interface NetworkStatus { ok: boolean; provider: string | null; addresses: string[]; error: string | null }

export interface Platform { os: string; arch: string; buildArch: string; rosetta: boolean }
export interface AppInfo {
  version: string; platform: Platform;
  paths: { data: string; cache: string; downloads: string; apps: string; runtimes: string };
}

export interface RateInfo { limit: number | null; remaining: number | null; reset: number | null; authenticated: boolean; lastStatus: number | null }
export interface ApiStatus { rate: RateInfo; tokenSource: string | null }

export interface Backend { id: "cuda" | "amd" | "metal" | "cpu"; name: string; available: boolean; detail: string }
export interface HardwareReport {
  os: string; arch: string; logicalCores: number; cpuFeatures: string[];
  gpus: { vendor: string; name: string; driver: string | null }[]; backends: Backend[]; recommended: string;
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  products: (force = false) => invoke<ProductView[]>("get_products", { force }),
  install: (productId: string, tag?: string) => invoke<InstallOutcome>("install_app", { productId, tag: tag ?? null }),
  launch: (productId: string) => invoke<void>("launch_app", { productId }),
  uninstall: (productId: string) => invoke<void>("uninstall_app", { productId }),
  rollback: (productId: string) => invoke<string>("rollback_app", { productId }),
  openFolder: (productId: string) => invoke<void>("open_app_folder", { productId }),
  openDataDir: () => invoke<void>("open_data_dir"),
  openReleasePage: (url: string) => invoke<void>("open_release_page", { url }),
  jobs: () => invoke<JobInfo[]>("list_jobs"),
  pauseJob: (id: number) => invoke<void>("pause_job", { id }),
  resumeJob: (id: number) => invoke<void>("resume_job", { id }),
  cancelJob: (id: number) => invoke<void>("cancel_job", { id }),
  clearFinished: () => invoke<void>("clear_finished_jobs"),
  settings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  setChannel: (productId: string, channel: Channel) => invoke<void>("set_channel", { productId, channel }),
  githubStatus: () => invoke<ApiStatus>("github_status"),
  clearApiCache: () => invoke<void>("clear_api_cache"),
  hardware: () => invoke<HardwareReport>("detect_hardware"),
  selfUpdateStatus: () => invoke<SelfUpdateStatus>("self_update_status"),
  checkSelfUpdate: () => invoke<SelfUpdateStatus>("check_self_update"),
  downloadSelfUpdate: () => invoke<number>("download_self_update"),
  applySelfUpdate: () => invoke<void>("apply_self_update"),
  networkStatus: () => invoke<NetworkStatus>("network_status"),
  onSelfUpdate: (cb: (s: SelfUpdateStatus) => void): Promise<UnlistenFn> => listen<SelfUpdateStatus>("selfupdate://status", (e) => cb(e.payload)),
  onJob: (cb: (j: JobInfo) => void): Promise<UnlistenFn> => listen<JobInfo>("downloads://job", (e) => cb(e.payload)),
  onAppsChanged: (cb: () => void): Promise<UnlistenFn> => listen("apps://changed", () => cb()),
};

export const ACTIVE_STATES: JobState[] = ["queued", "downloading", "paused", "verifying", "installing"];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatDate(iso: string | number | null): string {
  if (iso === null) return "—";
  const d = typeof iso === "number" ? new Date(iso * 1000) : new Date(iso);
  return d.toLocaleDateString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

export const CHANNEL_LABEL: Record<Channel, string> = { stable: "Stable 穩定版", beta: "Beta 測試版", alpha: "Alpha 搶先版" };
export const OS_LABEL: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };
export const ARCH_LABEL: Record<string, string> = { x86_64: "x64", aarch64: "ARM64" };
