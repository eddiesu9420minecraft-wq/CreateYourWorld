import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api, errText, fb, formatBytes, FB_CATEGORY, FB_REDACTION, FB_RESOLUTION, FB_STATUS, ROLE_RANK, TASK_STATUS, OS_LABEL, ARCH_LABEL,
  type FbAttachment, type FbCategory, type FbComment, type FbDeviceStart, type FbDraft, type FbFull, type FbNotification,
  type FbPreview, type FbProduct, type FbResolution, type FbRole, type FbServiceStatus, type FbStatus, type FbSummary, type FbTask,
  type FbUser, type TaskStatus,
} from "../api";
import { useStore } from "../store";
import { Badge, Button, Empty, Modal, PageHeader } from "../components/ui";
import { Icon } from "../components/Icon";
import { AnimatePresence, StaggerItem } from "../motion";

// All text from the backend is user-submitted and untrusted: it is rendered as plain text only (React escapes it;
// nothing is ever turned into HTML, Markdown or a command).

type Tab = "all" | "mine" | "tasks" | "notifications";
const STATUS_TONE: Record<FbStatus, "neutral" | "gold" | "ok" | "warn" | "danger"> = {
  open: "neutral", triaged: "gold", in_progress: "gold", fixed: "ok", released: "ok", closed: "neutral",
};
const CATEGORIES = Object.keys(FB_CATEGORY) as FbCategory[];
const STATUSES = Object.keys(FB_STATUS) as FbStatus[];
const TRANSITIONS: Record<FbStatus, FbStatus[]> = {
  open: ["triaged", "in_progress"], triaged: ["in_progress", "open"], in_progress: ["fixed", "triaged"],
  fixed: ["in_progress"], released: [], closed: ["open"],
};

const rank = (u: FbUser | null | undefined) => (u ? ROLE_RANK[u.role] ?? 0 : -1);
const when = (t: number) => new Date(t * 1000).toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const isLocal = (b: string | null) => !!b && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(b);

export function FeedbackPage({ unread, onUnread }: { unread: number; onUnread: (n: number) => void }) {
  const { run } = useStore();
  const [status, setStatus] = useState<FbServiceStatus | null>(null);
  const [products, setProducts] = useState<FbProduct[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [compose, setCompose] = useState(false);
  const [signIn, setSignIn] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const refreshStatus = useCallback(() => fb.status().then(setStatus).catch(() => {}), []);
  useEffect(() => {
    refreshStatus();
    fb.products().then(setProducts).catch(() => {});
    const un = fb.onSession(() => { refreshStatus(); setReload((n) => n + 1); });
    return () => { un.then((f) => f()); };
  }, [refreshStatus]);

  const user = status?.user ?? null;
  const staff = rank(user) >= 1;
  const productName = useCallback((id: string) => products.find((p) => p.id === id)?.name ?? id, [products]);

  return (
    <div className="page">
      <PageHeader
        title="反饋中心"
        subtitle="回報問題、提出建議，並追蹤處理進度。上傳前一定會先讓你預覽並確認內容。"
        actions={<>
          {user ? (
            <>
              <span className="chip small row gap-6"><Icon name="github" size={14} />{user.login}{user.role !== "user" && <Badge tone="gold">{user.role === "maintainer" ? "維護者" : "開發者"}</Badge>}</span>
              <Button kind="ghost" small onClick={() => run(() => fb.signOut())}>登出</Button>
            </>
          ) : (
            <Button icon="github" disabled={!status?.configured} onClick={() => setSignIn(true)}>以 GitHub 登入</Button>
          )}
          <Button kind="primary" icon="feedback" onClick={() => setCompose(true)}>新增反饋</Button>
        </>}
      />

      {status && !status.configured && (
        <div className="callout warn">
          <b>反饋服務尚未部署。</b>你仍可撰寫反饋並預覽將上傳的內容，但目前無法送出。{status.error && <div className="small mono mt-8">{status.error}</div>}
        </div>
      )}
      {status?.configured && isLocal(status.base) && <div className="callout small">已連線到本機開發用反饋服務：<span className="mono">{status.base}</span></div>}

      <div className="row gap-8 wrap category-tabs">
        {([["all", "全部反饋"], ["mine", "我的反饋"], ...(staff ? [["tasks", "開發任務"]] : []), ...(user ? [["notifications", `通知${unread ? `（${unread}）` : ""}`]] : [])] as [Tab, string][]).map(([id, label]) => (
          <button key={id} className={`chip category-tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {(tab === "all" || tab === "mine") && status?.configured && (
        <FeedbackList key={`${tab}-${reload}`} mine={tab === "mine"} signedIn={!!user} products={products} productName={productName} onOpen={setOpenId} />
      )}
      {(tab === "all" || tab === "mine") && status && !status.configured && <Empty icon="feedback" title="尚無可顯示的反饋">反饋服務部署後，這裡會列出所有人的回報與建議。</Empty>}
      {tab === "mine" && status?.configured && !user && <div className="muted small mt-8">登入後可查看自己送出的反饋。</div>}
      {tab === "tasks" && staff && <TaskList user={user!} productName={productName} onOpenFeedback={setOpenId} />}
      {tab === "notifications" && user && <Notifications onOpen={setOpenId} onUnread={onUnread} />}

      <AnimatePresence>
        {compose && <ComposeModal key="compose" products={products} status={status} onSignIn={() => setSignIn(true)} onClose={() => setCompose(false)}
          onSubmitted={(id) => { setCompose(false); setReload((n) => n + 1); setOpenId(id); }} />}
        {signIn && status && <SignInModal key="signin" status={status} onClose={() => { setSignIn(false); refreshStatus(); }} />}
        {openId && <FeedbackDetail key={openId} id={openId} user={user} productName={productName} onClose={() => { setOpenId(null); setReload((n) => n + 1); }} />}
      </AnimatePresence>
    </div>
  );
}

// ------------------------------------------------------------------ list ----

function FeedbackList({ mine, signedIn, products, productName, onOpen }: {
  mine: boolean; signedIn: boolean; products: FbProduct[]; productName: (id: string) => string; onOpen: (id: string) => void;
}) {
  const { toast } = useStore();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [product, setProduct] = useState("");
  const [category, setCategory] = useState<FbCategory | "">("");
  const [status, setStatus] = useState<FbStatus | "active" | "">("active");
  const [sort, setSort] = useState<"votes" | "new" | "updated">("new");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: FbSummary[]; total: number; per_page: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPage(1); }, [debounced, product, category, status, sort]);

  const load = useCallback(() => {
    if (mine && !signedIn) { setData({ items: [], total: 0, per_page: 20 }); return; }
    const query: Record<string, string> = { sort, page: String(page), per_page: "20" };
    if (debounced) query.q = debounced.slice(0, 100);
    if (product) query.product = product;
    if (category) query.category = category;
    if (status) query.status = status;
    if (mine) query.mine = "1";
    fb.call<{ items: FbSummary[]; total: number; per_page: number }>("GET", "/v1/feedback", query)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(errText(e)));
  }, [mine, signedIn, sort, page, debounced, product, category, status]);
  useEffect(load, [load]);

  const vote = async (f: FbSummary) => {
    if (!signedIn) { toast("info", "請先以 GitHub 登入再投票"); return; }
    try {
      const r = await fb.call<{ votes: number; my_vote: boolean }>(f.my_vote ? "DELETE" : "POST", `/v1/feedback/${f.id}/vote`);
      setData((d) => d && { ...d, items: d.items.map((x) => (x.id === f.id ? { ...x, votes: r.votes, my_vote: r.my_vote } : x)) });
    } catch (e) { toast("error", errText(e)); }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.per_page)) : 1;
  return (
    <>
      <div className="fb-filters row gap-8 wrap">
        <div className="search fb-search">
          <Icon name="search" size={16} />
          <input placeholder="搜尋反饋標題與內容" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select value={product} onChange={(e) => setProduct(e.target.value)} aria-label="軟體">
          <option value="">所有軟體</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value as FbCategory | "")} aria-label="類別">
          <option value="">所有類別</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{FB_CATEGORY[c]}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as FbStatus | "active" | "")} aria-label="狀態">
          <option value="active">進行中的</option>
          <option value="">所有狀態</option>
          {STATUSES.map((s) => <option key={s} value={s}>{FB_STATUS[s]}</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as "votes" | "new" | "updated")} aria-label="排序">
          <option value="new">最新</option>
          <option value="votes">最多票</option>
          <option value="updated">最近更新</option>
        </select>
      </div>
      {err && <div className="callout warn small">{err}</div>}
      {data && data.items.length === 0 && !err && <Empty icon="feedback" title={mine ? "你還沒有送出反饋" : "沒有符合條件的反饋"}>可以調整篩選條件，或新增一則反饋。</Empty>}
      {data && data.items.length > 0 && (
        <div className="card list fb-list">
          {data.items.map((f, i) => (
            <StaggerItem key={f.id} index={Math.min(i, 8)} className="list-row fb-row">
              <button className={`fb-vote${f.my_vote ? " on" : ""}`} onClick={() => vote(f)} title={f.my_vote ? "取消投票" : "投票"} aria-pressed={f.my_vote}>
                <Icon name="vote" size={16} /><span>{f.votes}</span>
              </button>
              <button className="fb-row-main" onClick={() => onOpen(f.id)}>
                <div className="fb-title">{f.title}<span className="muted small"> #{f.number}</span></div>
                <div className="row gap-6 wrap small muted mt-4">
                  <Badge tone={STATUS_TONE[f.status]}>{FB_STATUS[f.status]}{f.resolution ? `・${FB_RESOLUTION[f.resolution]}` : ""}</Badge>
                  <Badge>{FB_CATEGORY[f.category]}</Badge>
                  <span>{productName(f.product)}</span>
                  {f.fixed_in && <Badge tone="ok">已於 {f.fixed_in} 修復</Badge>}
                  {f.github && <span className="row gap-6"><Icon name="github" size={12} />#{f.github.number}</span>}
                  <span>·</span><span>{f.author?.login ?? "—"}</span><span>·</span><span>{when(f.created_at)}</span>
                </div>
              </button>
              <span className="row gap-6 muted small"><Icon name="comment" size={14} />{f.comments}</span>
            </StaggerItem>
          ))}
        </div>
      )}
      {pages > 1 && (
        <div className="row gap-8 mt-16" style={{ justifyContent: "center" }}>
          <Button small kind="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一頁</Button>
          <span className="muted small">{page} / {pages}</span>
          <Button small kind="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一頁</Button>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ compose + preview ----

const MAX_FILES = 5;
const ACCEPT = "image/png,image/jpeg,image/webp,.txt,.log,text/plain";

function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function ComposeModal({ products, status, onSignIn, onClose, onSubmitted }: {
  products: FbProduct[]; status: FbServiceStatus | null; onSignIn: () => void; onClose: () => void; onSubmitted: (id: string) => void;
}) {
  const { toast } = useStore();
  const [draft, setDraft] = useState<FbDraft>({ product: "CreateYourWorld", category: "bug", title: "", body: "", includeEnvironment: true, includeDiagnostics: false, attachments: [] });
  const [files, setFiles] = useState<{ filename: string; size: number; dataBase64: string }[]>([]);
  const [preview, setPreview] = useState<FbPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const set = <K extends keyof FbDraft>(k: K, v: FbDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const addFiles = async (list: FileList | File[]) => {
    const arr = Array.from(list);
    const room = MAX_FILES - files.length - (draft.includeDiagnostics ? 1 : 0);
    if (arr.length > room) toast("info", `最多 ${MAX_FILES} 個附件`);
    const next: typeof files = [];
    for (const f of arr.slice(0, Math.max(0, room))) {
      if (f.size > 4 * 1024 * 1024) { toast("error", `${f.name} 超過 4 MiB`); continue; }
      try {
        next.push({ filename: f.name || `screenshot-${Date.now()}.png`, size: f.size, dataBase64: await readAsBase64(f) });
      } catch (e) { toast("error", `無法讀取 ${f.name}：${errText(e)}`); }
    }
    setFiles((cur) => [...cur, ...next]);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  };

  const doPreview = async () => {
    setBusy(true); setError(null);
    try {
      setPreview(await fb.prepare({ ...draft, attachments: files.map(({ filename, dataBase64 }) => ({ filename, dataBase64 })) }));
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  const titleLen = [...draft.title.trim()].length;
  const bodyLen = [...draft.body.trim()].length;
  const valid = titleLen >= 5 && titleLen <= 120 && bodyLen >= 10 && bodyLen <= 8000;

  if (preview) {
    return <PreviewModal preview={preview} status={status} onSignIn={onSignIn}
      onBack={() => { fb.discard(preview.id).catch(() => {}); setPreview(null); }}
      onClose={() => { fb.discard(preview.id).catch(() => {}); onClose(); }} onSubmitted={onSubmitted} />;
  }

  return (
    <Modal wide title="新增反饋" onClose={onClose} footer={<>
      <Button kind="ghost" onClick={onClose}>取消</Button>
      <Button kind="primary" icon="shield" disabled={!valid || busy} onClick={doPreview}>{busy ? "整理中…" : "預覽將上傳的內容"}</Button>
    </>}>
      <div className="fb-form" onPaste={onPaste}>
        <div className="fb-form-row">
          <label>軟體
            <select value={draft.product} onChange={(e) => set("product", e.target.value)}>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.installed ? `（${p.installed}）` : ""}</option>)}
            </select>
          </label>
          <label>類別
            <select value={draft.category} onChange={(e) => set("category", e.target.value as FbCategory)}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{FB_CATEGORY[c]}</option>)}
            </select>
          </label>
        </div>
        <label>標題 <span className="muted small">{titleLen}/120</span>
          <input className="fb-input" value={draft.title} maxLength={140} placeholder="一句話描述問題或建議" onChange={(e) => set("title", e.target.value)} />
        </label>
        <label>內容 <span className="muted small">{bodyLen}/8000</span>
          <textarea className="fb-input fb-textarea" value={draft.body} maxLength={9000}
            placeholder={draft.category === "bug" ? "發生了什麼？重現步驟？預期的結果？" : "請描述你的想法或遇到的情況"} onChange={(e) => set("body", e.target.value)} />
        </label>
        <div className="fb-attach">
          <div className="row gap-8">
            <Button small icon="clip" onClick={() => fileInput.current?.click()} disabled={files.length >= MAX_FILES}>加入圖片／日誌</Button>
            <span className="muted small">PNG、JPEG、WebP（≤ 4 MiB）或文字日誌（≤ 1 MiB）；也可以直接貼上截圖。</span>
            <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
          </div>
          {files.map((f, i) => (
            <div key={i} className="row gap-8 small fb-file">
              <Icon name="clip" size={14} /><span className="grow">{f.filename}</span><span className="muted">{formatBytes(f.size)}</span>
              <button className="icon-btn" aria-label="移除" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}><Icon name="close" size={14} /></button>
            </div>
          ))}
        </div>
        <label className="row gap-8 fb-check"><input type="checkbox" className="switch" checked={draft.includeEnvironment} onChange={(e) => set("includeEnvironment", e.target.checked)} />
          附上軟體版本、作業系統與 CPU 架構（可在預覽中查看）</label>
        <label className="row gap-8 fb-check"><input type="checkbox" className="switch" checked={draft.includeDiagnostics} onChange={(e) => set("includeDiagnostics", e.target.checked)} />
          附上 CYW 診斷日誌（最近的下載／安裝錯誤，會自動遮蔽）</label>
        <div className="callout small"><Icon name="lock" size={14} /> 按下「預覽」只會在本機整理資料：Token、私鑰、密碼、IP、使用者名稱與敏感路徑會自動遮蔽，圖片的 EXIF／GPS 等中繼資料會被移除。確認之前不會上傳任何東西。</div>
        {error && <div className="callout warn small">{error}</div>}
      </div>
    </Modal>
  );
}

function PreviewModal({ preview, status, onSignIn, onBack, onClose, onSubmitted }: {
  preview: FbPreview; status: FbServiceStatus | null; onSignIn: () => void; onBack: () => void; onClose: () => void; onSubmitted: (id: string) => void;
}) {
  const { toast } = useStore();
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const red = Object.entries(preview.redactions);
  const env = preview.payload.environment as Record<string, string | null> | null;
  const canSend = !!status?.configured && !!status.user;

  const send = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fb.submit(preview.id, preview.sha256);
      if (r.attachmentErrors.length) toast("error", `部分附件上傳失敗：${r.attachmentErrors.join("；")}`);
      toast("ok", `已送出反饋 #${r.feedback.number}`);
      onSubmitted(r.feedback.id);
    } catch (e) { setError(errText(e)); setBusy(false); }
  };

  return (
    <Modal wide title="確認將上傳的內容" onClose={onClose} footer={<>
      <Button kind="ghost" onClick={onBack}>返回修改</Button>
      {!status?.user && status?.configured && <Button icon="github" onClick={onSignIn}>以 GitHub 登入</Button>}
      <Button kind="primary" icon="check" disabled={!agree || !canSend || busy} onClick={send}>{busy ? "上傳中…" : "確認並上傳"}</Button>
    </>}>
      <div className="fb-preview">
        <div className="muted small">目的地：<span className="mono">{preview.endpoint}</span></div>
        <div className="fb-redact row gap-6 wrap">
          <Icon name="shield" size={14} />
          {red.length === 0 ? <span className="small muted">沒有偵測到需要遮蔽的敏感資料。</span>
            : red.map(([k, n]) => <Badge key={k} tone="gold">{FB_REDACTION[k] ?? k} × {n}</Badge>)}
        </div>
        <Section title="標題"><div className="fb-text">{String(preview.payload.title)}</div></Section>
        <Section title="內容"><pre className="notes fb-text">{String(preview.payload.body)}</pre></Section>
        <Section title="環境資訊">
          {env ? (
            <div className="fb-env small">
              <span>軟體版本</span><span className="mono">{env.product_version ?? "未安裝"}</span>
              <span>CYW</span><span className="mono">{env.cyw_version}</span>
              <span>作業系統</span><span className="mono">{env.os_version || (OS_LABEL[env.os ?? ""] ?? env.os)}</span>
              <span>CPU 架構</span><span className="mono">{ARCH_LABEL[env.arch ?? ""] ?? env.arch}</span>
            </div>
          ) : <span className="muted small">不附上（你已取消勾選）。</span>}
        </Section>
        {preview.attachments.length > 0 && (
          <Section title={`附件（${preview.attachments.length}）`}>
            <div className="fb-attach-preview">
              {preview.attachments.map((a) => (
                <div key={a.sha256 + a.filename} className="card fb-attach-card">
                  <div className="row gap-8 small"><b className="grow">{a.filename}</b><span className="muted">{a.contentType} · {formatBytes(a.size)}</span></div>
                  {a.dataUrl && <img src={a.dataUrl} alt={a.filename} className="fb-thumb" />}
                  {a.text !== null && <pre className="notes fb-log">{a.text}</pre>}
                  <div className="row gap-6 wrap small">
                    {a.metadataRemoved > 0 && <Badge tone="ok">已移除 {a.metadataRemoved} 個中繼資料區塊</Badge>}
                    {Object.entries(a.redactions).map(([k, n]) => <Badge key={k} tone="gold">{FB_REDACTION[k] ?? k} × {n}</Badge>)}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}
        {preview.warnings.map((w, i) => <div key={i} className="callout warn small">{w}</div>)}
        <details className="small muted"><summary>完整的上傳資料（JSON）</summary><pre className="notes mono">{JSON.stringify(preview.payload, null, 2)}</pre></details>
        {!status?.configured && <div className="callout warn small">反饋服務尚未部署，目前無法上傳。</div>}
        {status?.configured && !status.user && <div className="callout small">送出前需要以 GitHub 登入（只用來識別你的帳號，CYW 不會取得你的 GitHub Token）。</div>}
        <label className="row gap-8 fb-check fb-agree">
          <input type="checkbox" className="switch" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          我已檢查以上內容，同意將它們上傳到反饋服務。反饋內容（不含附件與環境資訊）會公開顯示。
        </label>
        {error && <div className="callout warn small">{error}</div>}
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div className="fb-section"><div className="fb-section-title">{title}</div>{children}</div>;
}

// ------------------------------------------------------------------ sign-in ----

function SignInModal({ status, onClose }: { status: FbServiceStatus; onClose: () => void }) {
  const { toast } = useStore();
  const [dev, setDev] = useState<FbDeviceStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState("tester");
  const [role, setRole] = useState<FbRole>("user");
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const start = async () => {
    setError(null);
    try {
      const d = await fb.signInStart();
      setDev(d);
      const deadline = Date.now() + d.expiresIn * 1000;
      let interval = d.interval;
      const poll = async () => {
        if (Date.now() > deadline) { setError("驗證碼已過期，請重新開始"); return; }
        try {
          const u = await fb.signInPoll();
          if (u) { toast("ok", `已登入：${u.login}`); onClose(); return; }
        } catch (e) {
          const t = errText(e);
          if (t.includes("slow_down")) interval += 5;
          else { setError(t); return; }
        }
        timer.current = window.setTimeout(poll, interval * 1000);
      };
      timer.current = window.setTimeout(poll, interval * 1000);
    } catch (e) { setError(errText(e)); }
  };

  return (
    <Modal title="以 GitHub 登入反饋中心" onClose={onClose}>
      <p className="muted small">使用 GitHub 裝置登入：CYW 只會取得反饋服務的工作階段，不會取得或保存你的 GitHub Token 與密碼。</p>
      {!dev && <Button kind="primary" icon="github" onClick={start}>開始登入</Button>}
      {dev && (
        <div className="fb-device">
          <div className="muted small">已在瀏覽器開啟 <span className="mono">{dev.verificationUri}</span>，請輸入下列代碼：</div>
          <div className="fb-code mono">{dev.userCode}</div>
          <div className="muted small row gap-6"><Icon name="refresh" size={14} className="spin" />等待 GitHub 授權…</div>
        </div>
      )}
      {error && <div className="callout warn small mt-8">{error}</div>}
      {isLocal(status.base) && (
        <details className="mt-16 small">
          <summary>本機開發登入（僅限 127.0.0.1 的開發用服務）</summary>
          <div className="row gap-8 mt-8">
            <input className="fb-input" value={login} onChange={(e) => setLogin(e.target.value)} aria-label="帳號" />
            <select value={role} onChange={(e) => setRole(e.target.value as FbRole)} aria-label="角色">
              <option value="user">一般使用者</option><option value="developer">開發者</option><option value="maintainer">維護者</option>
            </select>
            <Button small onClick={async () => { try { await fb.devSignIn(login, role); onClose(); } catch (e) { setError(errText(e)); } }}>登入</Button>
          </div>
        </details>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ detail ----

function FeedbackDetail({ id, user, productName, onClose }: { id: string; user: FbUser | null; productName: (id: string) => string; onClose: () => void }) {
  const { toast } = useStore();
  const [f, setF] = useState<FbFull | null>(null);
  const [comments, setComments] = useState<FbComment[]>([]);
  const [text, setText] = useState("");
  const [official, setOfficial] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const staff = rank(user) >= 1;
  const maintainer = rank(user) >= 2;
  const mine = !!user && f?.author?.login === user.login;

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([
        fb.call<{ feedback: FbFull }>("GET", `/v1/feedback/${id}`),
        fb.call<{ items: FbComment[] }>("GET", `/v1/feedback/${id}/comments`),
      ]);
      setF(d.feedback); setComments(c.items); setError(null);
    } catch (e) { setError(errText(e)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast("ok", ok); await load(); } catch (e) { toast("error", errText(e)); } finally { setBusy(false); }
  };

  const comment = () => act(async () => {
    await fb.call("POST", `/v1/feedback/${id}/comments`, undefined, { body: text, official: staff && official });
    setText(""); setOfficial(false);
  }, "已送出留言");

  return (
    <Modal wide title={f ? <span>{f.title} <span className="muted small">#{f.number}</span></span> : "反饋"} onClose={onClose}>
      {error && <div className="callout warn small">{error}</div>}
      {!f && !error && <div className="muted">載入中…</div>}
      {f && (
        <div className="fb-detail">
          <div className="row gap-6 wrap small">
            <Badge tone={STATUS_TONE[f.status]}>{FB_STATUS[f.status]}{f.resolution ? `・${FB_RESOLUTION[f.resolution]}` : ""}</Badge>
            <Badge>{FB_CATEGORY[f.category]}</Badge>
            <span className="muted">{productName(f.product)}</span>
            {f.fixed_in && <Badge tone="ok">已於 {f.fixed_in} 修復</Badge>}
            {f.labels.map((l) => <Badge key={l}>{l}</Badge>)}
            <span className="muted">· {f.author?.login ?? "—"} · {when(f.created_at)}</span>
            <span className="grow" />
            {f.github && <Button small kind="ghost" icon="github" onClick={() => api.openReleasePage(f.github!.url).catch(() => {})}>GitHub #{f.github.number}</Button>}
            {user && <Button small kind="ghost" icon="bell" onClick={() => act(() => fb.call(f.subscribed ? "DELETE" : "POST", `/v1/feedback/${id}/subscription`), f.subscribed ? "已取消追蹤" : "已追蹤，狀態變更與修復發布時會通知你")}>{f.subscribed ? "取消追蹤" : "追蹤"}</Button>}
            <Button small kind={f.my_vote ? "primary" : "secondary"} icon="vote" disabled={!user || busy} onClick={() => act(() => fb.call(f.my_vote ? "DELETE" : "POST", `/v1/feedback/${id}/vote`))}>{f.votes}</Button>
          </div>

          <pre className="notes fb-text fb-body">{f.body}</pre>

          {f.environment && (
            <div className="fb-env small card">
              <span>軟體版本</span><span className="mono">{f.environment.product_version ?? "—"}</span>
              <span>CYW</span><span className="mono">{f.environment.cyw_version}</span>
              <span>作業系統</span><span className="mono">{f.environment.os_version || (OS_LABEL[f.environment.os] ?? f.environment.os)}</span>
              <span>CPU 架構</span><span className="mono">{ARCH_LABEL[f.environment.arch] ?? f.environment.arch}</span>
            </div>
          )}
          {f.attachments.length > 0 && <Attachments items={f.attachments} />}

          {staff && <StaffPanel f={f} maintainer={maintainer} busy={busy} act={act} />}
          {!staff && mine && f.status !== "closed" && f.status !== "released" && (
            <div className="row gap-8"><Button small kind="ghost" onClick={() => act(() => fb.call("POST", `/v1/feedback/${id}/close`, undefined, { resolution: "completed" }), "已關閉")}>問題已解決，關閉反饋</Button></div>
          )}

          {f.events.length > 0 && (
            <div className="fb-section">
              <div className="fb-section-title">處理紀錄</div>
              <div className="fb-timeline">
                {f.events.map((e) => (
                  <div key={e.id} className="small fb-event">
                    <span className="fb-dot" />
                    <span className="muted">{when(e.created_at)}</span>
                    <span>{e.actor?.login ?? "系統"}</span>
                    <span>{eventText(e.kind, e.from, e.to)}</span>
                    {e.note && <span className="muted">— {e.note}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="fb-section">
            <div className="fb-section-title">留言（{comments.length}）</div>
            {comments.map((c) => (
              <div key={c.id} className={`fb-comment${c.official ? " official" : ""}`}>
                <div className="row gap-6 small">
                  <b>{c.source === "github" ? c.github_author ?? "GitHub" : c.author?.login ?? "—"}</b>
                  {c.official && <Badge tone="gold">開發者回覆</Badge>}
                  {c.source === "github" && <Badge><Icon name="github" size={11} />GitHub</Badge>}
                  <span className="muted">{when(c.created_at)}</span>
                  <span className="grow" />
                  {maintainer && !c.hidden && <button className="icon-btn" title="隱藏留言" onClick={() => act(() => fb.call("DELETE", `/v1/comments/${c.id}`), "已隱藏")}><Icon name="trash" size={14} /></button>}
                </div>
                {c.hidden ? <div className="muted small">（此留言已被管理員隱藏）</div> : <pre className="fb-text fb-comment-body">{c.body}</pre>}
              </div>
            ))}
            {user ? (
              <div className="fb-reply">
                <textarea className="fb-input fb-textarea small-area" value={text} maxLength={4000} placeholder="留言（送出前會自動遮蔽敏感資料）" onChange={(e) => setText(e.target.value)} />
                <div className="row gap-8">
                  {staff && <label className="row gap-6 small"><input type="checkbox" className="switch" checked={official} onChange={(e) => setOfficial(e.target.checked)} />以開發者身分回覆（會通知追蹤者）</label>}
                  <span className="grow" />
                  <Button small kind="primary" disabled={!text.trim() || busy} onClick={comment}>送出留言</Button>
                </div>
              </div>
            ) : <div className="muted small">登入後即可留言與投票。</div>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function eventText(kind: string, from: string | null, to: string | null): string {
  const st = (s: string | null) => (s && s in FB_STATUS ? FB_STATUS[s as FbStatus] : s ?? "");
  switch (kind) {
    case "status": return `狀態：${st(from)} → ${st(to)}`;
    case "assign": return to ? `指派給 ${to}` : "取消指派";
    case "github_linked": return `已同步到 GitHub ${to ?? ""}`;
    case "release": return `修復已發布：${to ?? ""}`;
    case "task": return `已建立開發任務 ${to ?? ""}`;
    default: return kind;
  }
}

function Attachments({ items }: { items: FbAttachment[] }) {
  const [data, setData] = useState<Record<string, { url?: string; text?: string; error?: string }>>({});
  const load = async (a: FbAttachment) => {
    try {
      const r = await fb.attachment(a.id);
      setData((d) => ({ ...d, [a.id]: r.contentType.startsWith("image/") ? { url: `data:${r.contentType};base64,${r.dataBase64}` } : { text: new TextDecoder().decode(Uint8Array.from(atob(r.dataBase64), (c) => c.charCodeAt(0))) } }));
    } catch (e) { setData((d) => ({ ...d, [a.id]: { error: errText(e) } })); }
  };
  return (
    <div className="fb-section">
      <div className="fb-section-title">附件（只有你與開發者看得到）</div>
      <div className="fb-attach-preview">
        {items.map((a) => (
          <div key={a.id} className="card fb-attach-card">
            <div className="row gap-8 small"><Icon name="clip" size={14} /><b className="grow">{a.filename}</b><span className="muted">{formatBytes(a.size)}</span>
              {!data[a.id] && <Button small kind="ghost" onClick={() => load(a)}>檢視</Button>}</div>
            {data[a.id]?.url && <img src={data[a.id].url} alt={a.filename} className="fb-thumb" />}
            {data[a.id]?.text !== undefined && <pre className="notes fb-log">{data[a.id].text}</pre>}
            {data[a.id]?.error && <div className="danger small">{data[a.id].error}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function StaffPanel({ f, maintainer, busy, act }: { f: FbFull; maintainer: boolean; busy: boolean; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const [assignee, setAssignee] = useState(f.assignee?.login ?? "");
  const [labels, setLabels] = useState(f.labels.join(", "));
  const [resolution, setResolution] = useState<FbResolution>("completed");
  const [note, setNote] = useState("");
  const [agentAllowed, setAgentAllowed] = useState(false);
  const patch = (body: Record<string, unknown>, ok: string) => act(() => fb.call("PATCH", `/v1/feedback/${f.id}`, undefined, body), ok);
  const closed = f.status === "closed" || f.status === "released";

  return (
    <div className="card fb-staff">
      <div className="fb-section-title row gap-6"><Icon name="shield" size={14} />開發者管理</div>
      <div className="row gap-8 wrap">
        {TRANSITIONS[f.status].map((s) => <Button key={s} small disabled={busy} onClick={() => patch({ status: s }, `狀態已改為「${FB_STATUS[s]}」`)}>→ {FB_STATUS[s]}</Button>)}
        {!f.github && <Button small icon="github" disabled={busy} onClick={() => act(() => fb.call("POST", `/v1/feedback/${f.id}/github`), "已建立 GitHub Issue")}>同步到 GitHub Issues</Button>}
      </div>
      <div className="row gap-8 wrap mt-8">
        <input className="fb-input fb-inline" value={assignee} placeholder="指派給（GitHub 帳號）" onChange={(e) => setAssignee(e.target.value)} />
        <Button small disabled={busy} onClick={() => patch({ assignee: assignee.trim() || null }, "已更新指派")}>指派</Button>
        <input className="fb-input fb-inline" value={labels} placeholder="標籤，以逗號分隔" onChange={(e) => setLabels(e.target.value)} />
        <Button small disabled={busy} onClick={() => patch({ labels: labels.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10) }, "已更新標籤")}>更新標籤</Button>
      </div>
      {!closed && (
        <div className="row gap-8 wrap mt-8">
          <select value={resolution} onChange={(e) => setResolution(e.target.value as FbResolution)} aria-label="關閉原因">
            {(Object.keys(FB_RESOLUTION) as FbResolution[]).map((r) => <option key={r} value={r}>{FB_RESOLUTION[r]}</option>)}
          </select>
          <input className="fb-input fb-inline" value={note} maxLength={500} placeholder="備註（選填）" onChange={(e) => setNote(e.target.value)} />
          <Button small kind="danger" disabled={busy} onClick={() => act(() => fb.call("POST", `/v1/feedback/${f.id}/close`, undefined, { resolution, note: note || undefined }), "已關閉反饋")}>關閉反饋</Button>
        </div>
      )}
      {maintainer && !closed && (
        <div className="row gap-8 wrap mt-8">
          <label className="row gap-6 small"><input type="checkbox" className="switch" checked={agentAllowed} onChange={(e) => setAgentAllowed(e.target.checked)} />允許 AI Agent 分析並提交修復 PR</label>
          <Button small icon="task" disabled={busy} onClick={() => act(() => fb.call("POST", `/v1/feedback/${f.id}/tasks`, undefined, { agent_allowed: agentAllowed, assignee: assignee.trim() || undefined }), "已轉換為 CYWS 開發任務")}>轉換為 CYWS 開發任務</Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ tasks ----

function TaskList({ user, productName, onOpenFeedback }: { user: FbUser; productName: (id: string) => string; onOpenFeedback: (id: string) => void }) {
  const { toast } = useStore();
  const [items, setItems] = useState<FbTask[] | null>(null);
  const [filter, setFilter] = useState<TaskStatus | "">("");
  const [open, setOpen] = useState<FbTask | null>(null);
  const [release, setRelease] = useState(false);
  const load = useCallback(() => {
    fb.call<{ items: FbTask[] }>("GET", "/v1/tasks", filter ? { status: filter } : {}).then((r) => setItems(r.items)).catch((e) => toast("error", errText(e)));
  }, [filter, toast]);
  useEffect(load, [load]);
  const maintainer = rank(user) >= 2;

  return (
    <>
      <div className="row gap-8 wrap fb-filters">
        <select value={filter} onChange={(e) => setFilter(e.target.value as TaskStatus | "")} aria-label="任務狀態">
          <option value="">所有任務</option>
          {(Object.keys(TASK_STATUS) as TaskStatus[]).map((s) => <option key={s} value={s}>{TASK_STATUS[s]}</option>)}
        </select>
        <span className="grow" />
        {maintainer && <Button small icon="check" onClick={() => setRelease(true)}>記錄已發布的修復版本</Button>}
      </div>
      <div className="callout small"><Icon name="alert" size={14} /> 任務來源是使用者提交的不可信任資料。AI Agent 只能分析與提交 PR；合併與正式發布一律需要人工審核。</div>
      {items && items.length === 0 && <Empty icon="task" title="沒有開發任務">維護者可以在反饋詳情中把反饋轉換為 CYWS 開發任務。</Empty>}
      {items && items.length > 0 && (
        <div className="card list">
          {items.map((t, i) => (
            <StaggerItem key={t.id} index={Math.min(i, 8)} className="list-row">
              <button className="fb-row-main" onClick={() => setOpen(t)}>
                <div className="fb-title">{t.title}<span className="muted small"> · 反饋 #{t.feedback_number}</span></div>
                <div className="row gap-6 wrap small muted mt-4">
                  <Badge tone={t.status === "done" ? "ok" : t.status === "in_review" ? "gold" : "neutral"}>{TASK_STATUS[t.status]}</Badge>
                  <span>{productName(t.product)}</span>
                  {t.agent_allowed && <Badge>AI Agent 可處理</Badge>}
                  {t.pull_requests.length > 0 && <Badge tone="gold">PR × {t.pull_requests.length}</Badge>}
                  <span>· 指派：{t.assignee?.login ?? "未指派"}</span>
                </div>
              </button>
            </StaggerItem>
          ))}
        </div>
      )}
      <AnimatePresence>
        {open && <TaskDetail key={open.id} task={open} user={user} onOpenFeedback={(id) => { setOpen(null); onOpenFeedback(id); }} onClose={() => { setOpen(null); load(); }} />}
        {release && <ReleaseModal key="release" onClose={() => setRelease(false)} />}
      </AnimatePresence>
    </>
  );
}

function TaskDetail({ task, user, onOpenFeedback, onClose }: { task: FbTask; user: FbUser; onOpenFeedback: (id: string) => void; onClose: () => void }) {
  const { toast } = useStore();
  const [t, setT] = useState(task);
  const [summary, setSummary] = useState("");
  const [pr, setPr] = useState("");
  const [assignee, setAssignee] = useState(task.assignee?.login ?? "");
  const maintainer = rank(user) >= 2;
  const reload = () => fb.call<{ task: FbTask }>("GET", `/v1/tasks/${t.id}`).then((r) => setT(r.task));
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast("ok", ok); await reload(); } catch (e) { toast("error", errText(e)); } };

  return (
    <Modal wide title={<span>{t.title} <span className="muted small">任務</span></span>} onClose={onClose}>
      <div className="fb-detail">
        <div className="row gap-6 wrap small">
          <Badge tone="gold">{TASK_STATUS[t.status]}</Badge><span className="muted mono">{t.repo}</span>
          <span className="grow" /><Button small kind="ghost" onClick={() => onOpenFeedback(t.feedback_id)}>開啟反饋 #{t.feedback_number}</Button>
        </div>
        <div className="callout warn small"><b>不可信任的使用者內容</b> — {t.source.handling}</div>
        <pre className="notes fb-text fb-body">{t.source.title}{"\n\n"}{t.source.body}</pre>
        <div className="row gap-8 wrap">
          {(["todo", "in_progress", "in_review", "done", "wont_do"] as TaskStatus[]).filter((s) => s !== t.status).map((s) => (
            <Button key={s} small onClick={() => act(() => fb.call("PATCH", `/v1/tasks/${t.id}`, undefined, { status: s }), `任務狀態：${TASK_STATUS[s]}`)}>→ {TASK_STATUS[s]}</Button>
          ))}
        </div>
        {maintainer && (
          <div className="row gap-8 wrap">
            <input className="fb-input fb-inline" value={assignee} placeholder="指派給（GitHub 帳號）" onChange={(e) => setAssignee(e.target.value)} />
            <Button small onClick={() => act(() => fb.call("PATCH", `/v1/tasks/${t.id}`, undefined, { assignee: assignee.trim() || null }), "已指派")}>指派開發者</Button>
          </div>
        )}
        <div className="fb-section">
          <div className="fb-section-title">分析（{t.analysis.length}）</div>
          {t.analysis.map((a) => (
            <div key={a.id} className="fb-comment"><div className="row gap-6 small"><b>{a.author.name}</b><Badge>{a.author.kind === "agent" ? "AI Agent" : a.author.kind}</Badge><span className="muted">{when(a.created_at)}</span></div><pre className="fb-text fb-comment-body">{a.summary}</pre></div>
          ))}
          <textarea className="fb-input fb-textarea small-area" value={summary} maxLength={8000} placeholder="加入分析" onChange={(e) => setSummary(e.target.value)} />
          <div className="row"><span className="grow" /><Button small disabled={!summary.trim()} onClick={() => act(async () => { await fb.call("POST", `/v1/tasks/${t.id}/analysis`, undefined, { summary }); setSummary(""); }, "已加入分析")}>加入分析</Button></div>
        </div>
        <div className="fb-section">
          <div className="fb-section-title">修復 PR（{t.pull_requests.length}）</div>
          {t.pull_requests.map((p) => (
            <div key={p.url} className="row gap-8 small"><Icon name="github" size={14} /><button className="linkish mono" onClick={() => api.openReleasePage(p.url).catch(() => {})}>{p.repo}#{p.number}</button><span className="muted">由 {p.added_by.name}（{p.added_by.kind}）</span></div>
          ))}
          <div className="row gap-8 mt-8">
            <input className="fb-input grow" value={pr} placeholder={`https://github.com/${t.repo}/pull/123`} onChange={(e) => setPr(e.target.value)} />
            <Button small disabled={!pr.trim()} onClick={() => act(async () => { await fb.call("POST", `/v1/tasks/${t.id}/pull-requests`, undefined, { url: pr.trim() }); setPr(""); }, "已連結 PR")}>連結 PR</Button>
          </div>
          <div className="muted small mt-8">PR 需由人工審核並合併；正式發布不會因為任何自動判定而發生。</div>
        </div>
      </div>
    </Modal>
  );
}

function ReleaseModal({ onClose }: { onClose: () => void }) {
  const { toast } = useStore();
  const [products, setProducts] = useState<FbProduct[]>([]);
  const [product, setProduct] = useState("CreateYourWorld");
  const [version, setVersion] = useState("");
  const [url, setUrl] = useState("");
  const [numbers, setNumbers] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { fb.products().then(setProducts).catch(() => {}); }, []);
  const nums = useMemo(() => numbers.split(/[\s,]+/).map((s) => parseInt(s.replace(/^#/, ""), 10)).filter((n) => Number.isInteger(n) && n > 0), [numbers]);
  const send = async () => {
    try {
      const r = await fb.call<{ updated: number; notified: number }>("POST", "/v1/releases", undefined, { product, version: version.trim(), url: url.trim(), feedback_numbers: nums, human_approved: true });
      toast("ok", `已記錄：${r.updated} 則反饋標示為已發布，通知 ${r.notified} 位使用者`);
      onClose();
    } catch (e) { toast("error", errText(e)); }
  };
  return (
    <Modal title="記錄已發布的修復版本" onClose={onClose} footer={<>
      <Button kind="ghost" onClick={onClose}>取消</Button>
      <Button kind="primary" disabled={!confirmed || !version.trim() || !url.trim() || nums.length === 0} onClick={send}>記錄並通知</Button>
    </>}>
      <div className="fb-form">
        <div className="callout small">這裡不會發布任何版本，只是記錄<b>你已經在 GitHub 正式發布</b>的版本，並通知相關反饋的使用者。</div>
        <label>軟體<select value={product} onChange={(e) => setProduct(e.target.value)}>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>版本<input className="fb-input" value={version} placeholder="v0.3.2" onChange={(e) => setVersion(e.target.value)} /></label>
        <label>Release 網址<input className="fb-input" value={url} placeholder="https://github.com/…/releases/tag/v0.3.2" onChange={(e) => setUrl(e.target.value)} /></label>
        <label>修復的反饋編號<input className="fb-input" value={numbers} placeholder="12, 15, 18" onChange={(e) => setNumbers(e.target.value)} /></label>
        <label className="row gap-8 fb-check"><input type="checkbox" className="switch" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我確認此版本已經人工審核並正式發布</label>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ notifications ----

function Notifications({ onOpen, onUnread }: { onOpen: (id: string) => void; onUnread: (n: number) => void }) {
  const { toast } = useStore();
  const [items, setItems] = useState<FbNotification[] | null>(null);
  const load = useCallback(() => {
    fb.call<{ items: FbNotification[]; unread: number }>("GET", "/v1/notifications").then((r) => { setItems(r.items); onUnread(r.unread); }).catch((e) => toast("error", errText(e)));
  }, [onUnread, toast]);
  useEffect(load, [load]);
  const markAll = async () => { await fb.call("POST", "/v1/notifications/read", undefined, {}); load(); };
  const open = async (n: FbNotification) => {
    if (!n.read) await fb.call("POST", "/v1/notifications/read", undefined, { ids: [n.id] }).catch(() => {});
    onOpen(n.feedback_id); load();
  };
  return (
    <>
      <div className="row fb-filters"><span className="grow" /><Button small kind="ghost" onClick={markAll}>全部標示為已讀</Button></div>
      {items && items.length === 0 && <Empty icon="bell" title="沒有通知">開發者回覆、狀態變更與修復版本發布時，會在這裡通知你。</Empty>}
      {items && items.length > 0 && (
        <div className="card list">
          {items.map((n, i) => (
            <StaggerItem key={n.id} index={Math.min(i, 8)} className={`list-row fb-notif${n.read ? "" : " unread"}`}>
              <Icon name={n.kind === "released" ? "check" : n.kind === "reply" ? "comment" : "bell"} />
              <button className="fb-row-main" onClick={() => open(n)}>
                <div className="fb-title">{n.title}</div>
                <div className="small muted">{n.body} · {when(n.created_at)}</div>
              </button>
              {!n.read && <span className="fb-unread-dot" />}
            </StaggerItem>
          ))}
        </div>
      )}
    </>
  );
}
