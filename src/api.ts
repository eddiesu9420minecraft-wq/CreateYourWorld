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
  /** "app" (has a window) or "devtool" (developer tools). */
  category: "app" | "devtool";
  /** Command-line binary (e.g. runxc.exe) for developer tools. */
  cli: string | null; onPath: boolean; pathProblem: string | null;
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
  setOnPath: (productId: string, enabled: boolean) => invoke<string | null>("set_on_path", { productId, enabled }),
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

// ------------------------------------------------------------------ Feedback Center (docs/feedback/API.md) ----

export type FbCategory = "bug" | "feature" | "performance" | "compatibility" | "general";
export type FbStatus = "open" | "triaged" | "in_progress" | "fixed" | "released" | "closed";
export type FbResolution = "completed" | "duplicate" | "wont_fix" | "invalid" | "spam";
export type FbRole = "user" | "developer" | "maintainer";
export type TaskStatus = "todo" | "in_progress" | "in_review" | "done" | "wont_do";

export interface FbUser { login: string; role: FbRole; avatar_url?: string | null }
export interface FbServiceStatus { configured: boolean; base: string | null; user: FbUser | null; error: string | null }
export interface FbProduct { id: string; name: string; installed: string | null }
export interface FbEnvironment { product_version: string | null; cyw_version: string; os: string; os_version: string | null; arch: string }
export interface FbSummary {
  id: string; number: number; product: string; category: FbCategory; title: string; status: FbStatus;
  resolution: FbResolution | null; votes: number; comments: number; author: FbUser | null;
  created_at: number; updated_at: number; github: { repo: string; number: number; url: string } | null;
  fixed_in: string | null; my_vote: boolean;
}
export interface FbAttachment { id: string; filename: string; content_type: string; size: number; created_at: number }
export interface FbEvent { id: string; kind: string; actor: FbUser | null; from: string | null; to: string | null; note: string | null; created_at: number }
export interface FbFull extends FbSummary {
  body: string; environment: FbEnvironment | null; attachments: FbAttachment[]; events: FbEvent[];
  assignee: FbUser | null; labels: string[]; duplicate_of: string | null; subscribed: boolean;
}
export interface FbComment { id: string; author: FbUser | null; body: string; official: boolean; source: "cyw" | "github"; github_author: string | null; hidden: boolean; created_at: number }
export interface FbNotification { id: string; feedback_id: string; kind: "reply" | "status" | "released"; title: string; body: string; created_at: number; read: boolean }
export interface FbTask {
  id: string; feedback_id: string; feedback_number: number; product: string; repo: string; title: string; status: TaskStatus;
  assignee: FbUser | null; agent_allowed: boolean;
  source: { untrusted: true; handling: string; title: string; body: string; environment: FbEnvironment | null };
  analysis: { id: string; author: { kind: string; name: string }; summary: string; created_at: number }[];
  pull_requests: { url: string; repo: string; number: number; added_by: { kind: string; name: string }; created_at: number }[];
  created_by: FbUser | null; created_at: number; updated_at: number;
}
export interface FbDraft {
  product: string; category: FbCategory; title: string; body: string;
  includeEnvironment: boolean; includeDiagnostics: boolean;
  attachments: { filename: string; dataBase64: string }[];
}
export interface FbAttachmentPreview {
  filename: string; contentType: string; size: number; sha256: string; metadataRemoved: number;
  redactions: Record<string, number>; text: string | null; dataUrl: string | null;
}
export interface FbPreview {
  id: string; sha256: string; endpoint: string; payload: Record<string, unknown>;
  redactions: Record<string, number>; attachments: FbAttachmentPreview[]; warnings: string[];
}
export interface FbSubmitResult { feedback: FbFull; serverRedactions: number; attachments: FbAttachment[]; attachmentErrors: string[] }
export interface FbDeviceStart { userCode: string; verificationUri: string; interval: number; expiresIn: number }

export const fb = {
  status: () => invoke<FbServiceStatus>("feedback_status"),
  products: () => invoke<FbProduct[]>("feedback_products"),
  signInStart: () => invoke<FbDeviceStart>("feedback_sign_in_start"),
  signInPoll: () => invoke<FbUser | null>("feedback_sign_in_poll"),
  devSignIn: (login: string, role: FbRole) => invoke<FbUser>("feedback_dev_sign_in", { login, role }),
  signOut: () => invoke<void>("feedback_sign_out"),
  prepare: (draft: FbDraft) => invoke<FbPreview>("feedback_prepare", { draft }),
  submit: (previewId: string, confirmedSha256: string) => invoke<FbSubmitResult>("feedback_submit", { previewId, confirmedSha256 }),
  discard: (previewId: string) => invoke<void>("feedback_discard", { previewId }),
  call: <T,>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, query?: Record<string, string>, body?: unknown) =>
    invoke<T>("feedback_api", { method, path, query: query ?? null, body: body ?? null }),
  attachment: (id: string) => invoke<{ contentType: string; dataBase64: string }>("feedback_attachment", { id }),
  onNotifications: (cb: (n: { items: FbNotification[]; unread: number }) => void): Promise<UnlistenFn> =>
    listen<{ items: FbNotification[]; unread: number }>("feedback://notifications", (e) => cb(e.payload)),
  onSession: (cb: () => void): Promise<UnlistenFn> => listen("feedback://session", () => cb()),
};

export const FB_CATEGORY: Record<FbCategory, string> = { bug: "Bug 回報", feature: "功能建議", performance: "效能問題", compatibility: "相容性問題", general: "一般反饋" };
export const FB_STATUS: Record<FbStatus, string> = { open: "待處理", triaged: "已確認", in_progress: "處理中", fixed: "已修復（待發布）", released: "已發布修復", closed: "已關閉" };
export const FB_RESOLUTION: Record<FbResolution, string> = { completed: "已完成", duplicate: "重複", wont_fix: "不修正", invalid: "無效", spam: "垃圾訊息" };
export const TASK_STATUS: Record<TaskStatus, string> = { todo: "待辦", in_progress: "進行中", in_review: "審核中", done: "完成", wont_do: "不處理" };
export const FB_REDACTION: Record<string, string> = {
  private_key: "私鑰", token: "Token／密碼", url_credentials: "網址內的帳密", email: "電子郵件", ip: "IP 位址",
  mac: "MAC 位址", user: "使用者名稱", host: "電腦名稱", path: "敏感路徑",
};
export const ROLE_RANK: Record<FbRole, number> = { user: 0, developer: 1, maintainer: 2 };
