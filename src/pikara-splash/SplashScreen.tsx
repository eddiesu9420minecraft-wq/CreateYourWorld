import { useEffect, useRef, useState } from "react";
import { PikaraLogo } from "./PikaraLogo";
import { splashBridge, type SplashSnapshot } from "./bridge";
import "./splash.css";

export interface SplashScreenProps {
  productName: string;
  tagline?: string;
  byline?: string;
  /** Exit animation length in ms (logo stretches to the corners and fades). */
  exitMs?: number;
}

/**
 * Self-contained splash for any Pikara app. Shows *real* backend init status and
 * drives the hand-off to the main window. Never delays on purpose: it exits as soon
 * as the backend and the main window both report ready.
 */
export function SplashScreen({ productName, tagline, byline, exitMs = 720 }: SplashScreenProps) {
  const [snap, setSnap] = useState<SplashSnapshot | null>(null);
  const [exiting, setExiting] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    let alive = true;
    const unsubs: Array<Promise<() => void>> = [];

    const exit = () => {
      if (started.current) return;
      started.current = true;
      setExiting(true);
      // Main appears underneath while the splash dissolves on top of it.
      splashBridge.revealMain().catch(() => {});
      window.setTimeout(() => splashBridge.close().catch(() => {}), exitMs + 40);
    };

    unsubs.push(splashBridge.onStatus((s) => alive && setSnap(s)));
    unsubs.push(splashBridge.onComplete(exit));
    splashBridge.status().then((s) => {
      if (!alive) return;
      setSnap(s);
      if (s.complete) exit();
    });

    // First paint done → let the backend show the window (avoids any blank frame).
    window.setTimeout(() => splashBridge.shown().catch(() => {}), 0);

    return () => {
      alive = false;
      unsubs.forEach((u) => u.then((f) => f()));
    };
  }, [exitMs]);

  const pct = snap && snap.total > 0 ? Math.min(100, (snap.step / snap.total) * 100) : 0;

  return (
    <div
      className={`pks-root${exiting ? " pks-exiting" : ""}`}
      style={{ ["--pks-exit" as string]: `${exitMs}ms` }}
      data-tauri-drag-region
    >
      <div className="pks-card" data-tauri-drag-region>
        <div className="pks-brand" data-tauri-drag-region>
          <PikaraLogo size={76} className="pks-logo" />
          <div className="pks-text" data-tauri-drag-region>
            <div className="pks-name">{productName}</div>
            {tagline && <div className="pks-tagline">{tagline}</div>}
            {byline && <div className="pks-byline">{byline}</div>}
          </div>
        </div>
        <div className="pks-footer">
          <div className="pks-status">
            <span>{snap?.message ?? "正在啟動…"}</span>
            {snap && snap.total > 0 && (
              <span className="pks-step">
                {Math.min(snap.step, snap.total)}/{snap.total}
              </span>
            )}
          </div>
          <div className="pks-bar">
            <div className="pks-bar-fill" style={{ width: `${pct}%` }} />
            {!snap?.complete && <div className="pks-bar-sheen" />}
          </div>
        </div>
      </div>
    </div>
  );
}
