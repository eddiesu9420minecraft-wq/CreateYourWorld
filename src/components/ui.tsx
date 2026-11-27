import { useState, type ReactNode } from "react";
import { formatBytes, type Check, type JobInfo, type VerifyReport } from "../api";
import { Icon } from "./Icon";
import { AnimatePresence, MotionBackdrop, MotionPanel } from "../motion";

export function Button({ children, onClick, kind = "secondary", disabled, icon, small, title }: {
  children?: ReactNode; onClick?: () => void; kind?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean; icon?: string; small?: boolean; title?: string;
}) {
  return (
    <button className={`btn btn-${kind}${small ? " btn-sm" : ""}`} onClick={onClick} disabled={disabled} title={title}>
      {icon && <Icon name={icon} size={small ? 14 : 16} />}
      {children}
    </button>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "gold" | "ok" | "warn" | "danger" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Progress({ value, indeterminate }: { value: number; indeterminate?: boolean }) {
  return (
    <div className={`progress${indeterminate ? " progress-indeterminate" : ""}`}>
      <div className="progress-fill" style={indeterminate ? undefined : { transform: `scaleX(${Math.max(0, Math.min(100, value)) / 100})` }} />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="row gap-8">{actions}</div>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={34} />
      <div className="empty-title">{title}</div>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function Modal({ title, children, onClose, footer, wide }: {
  title: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean;
}) {
  return (
    <MotionBackdrop className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <MotionPanel className={`modal${wide ? " modal-wide" : ""}`}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="關閉"><Icon name="close" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </MotionPanel>
    </MotionBackdrop>
  );
}

export function useConfirm() {
  const [state, setState] = useState<{ title: string; body: ReactNode; confirm: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const ask = (title: string, body: ReactNode, confirm = "確定", danger = false) =>
    new Promise<boolean>((resolve) => setState({ title, body, confirm, danger, resolve }));
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  const element = <AnimatePresence>{state && (
    <Modal title={state.title} onClose={() => close(false)} footer={
      <>
        <Button kind="ghost" onClick={() => close(false)}>取消</Button>
        <Button kind={state.danger ? "danger" : "primary"} onClick={() => close(true)}>{state.confirm}</Button>
      </>
    }>{state.body}</Modal>
  )}</AnimatePresence>;
  return { ask, element };
}

const CHECK_LABEL: Record<string, string> = { githubDigest: "GitHub 摘要", checksumFile: "SHA256SUMS", signature: "發布簽章" };

function checkTone(c: Check) {
  return c.status === "passed" ? "ok" : c.status === "failed" ? "danger" : "neutral";
}

export function VerifyBadges({ report }: { report: VerifyReport }) {
  return (
    <div className="row gap-6 wrap">
      {(["githubDigest", "checksumFile", "signature"] as const).map((k) => (
        <span key={k} title={report[k].detail}>
          <Badge tone={checkTone(report[k])}>
            {report[k].status === "passed" ? "✓" : report[k].status === "failed" ? "✕" : "–"} {CHECK_LABEL[k]}
          </Badge>
        </span>
      ))}
    </div>
  );
}

export function VerifyDetails({ report }: { report: VerifyReport }) {
  return (
    <div className="verify-details">
      <div className="mono small">SHA-256 {report.sha256}</div>
      {(["githubDigest", "checksumFile", "signature"] as const).map((k) => (
        <div key={k} className="row gap-8 small">
          <Badge tone={checkTone(report[k])}>{CHECK_LABEL[k]}</Badge>
          <span className="muted">{report[k].detail}</span>
        </div>
      ))}
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  queued: "排隊中", downloading: "下載中", paused: "已暫停", verifying: "驗證中",
  installing: "安裝中", completed: "已完成", failed: "失敗", canceled: "已取消",
};
export const jobStateLabel = (s: string) => STATE_LABEL[s] ?? s;

export function JobProgress({ job, compact }: { job: JobInfo; compact?: boolean }) {
  const pct = job.total > 0 ? (job.downloaded / job.total) * 100 : 0;
  const busy = job.state === "verifying" || job.state === "installing" || job.state === "queued";
  const eta = job.speed > 0 && job.total > job.downloaded ? Math.ceil((job.total - job.downloaded) / job.speed) : null;
  return (
    <div className={`job-progress${compact ? " compact" : ""}`}>
      <Progress value={pct} indeterminate={busy && job.state !== "queued"} />
      <div className="row space small muted">
        <span>
          {jobStateLabel(job.state)}
          {job.state === "downloading" && ` · ${formatBytes(job.downloaded)} / ${formatBytes(job.total)}`}
          {job.state === "paused" && job.downloaded > 0 && ` · 已下載 ${formatBytes(job.downloaded)}`}
        </span>
        {job.state === "downloading" && (
          <span className="mono">
            {formatBytes(job.speed)}/s{eta !== null && ` · 剩餘 ${eta >= 60 ? `${Math.floor(eta / 60)} 分 ${eta % 60} 秒` : `${eta} 秒`}`}
          </span>
        )}
      </div>
    </div>
  );
}
