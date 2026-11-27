import { useEffect, useState } from "react";
import { PikaraLogo } from "./PikaraLogo";
import { splashBridge } from "./bridge";
import "./splash.css";

/**
 * Lives in the main window. It is already painted (logo centred on the app background)
 * while the window is hidden, so the first visible frame continues the splash. On
 * `splash://reveal` the wedges stretch out to the window's four corners, grow and fade,
 * uncovering the app beneath. Removes itself afterwards.
 */
export function RevealOverlay({ durationMs = 900 }: { durationMs?: number }) {
  const [phase, setPhase] = useState<"hold" | "play" | "done">("hold");

  useEffect(() => {
    let timer = 0;
    const play = () => {
      setPhase((p) => (p === "hold" ? "play" : p));
      timer = window.setTimeout(() => setPhase("done"), durationMs + 60);
    };
    const un = splashBridge.onReveal(play);
    // Mounted after the hand-off already happened (e.g. page reload): play right away.
    splashBridge.status().then((s) => s.complete && window.setTimeout(play, 300)).catch(() => {});
    // If the window became visible without the event (fallback path), play anyway.
    const onVis = () => document.visibilityState === "visible" && window.setTimeout(play, 50);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      un.then((f) => f());
      document.removeEventListener("visibilitychange", onVis);
      window.clearTimeout(timer);
    };
  }, [durationMs]);

  if (phase === "done") return null;
  return (
    <div
      className={`pkr-overlay${phase === "play" ? " pkr-play" : ""}`}
      style={{ ["--pkr-dur" as string]: `${durationMs}ms` }}
      aria-hidden
    >
      <PikaraLogo size={120} className="pkr-logo" />
    </div>
  );
}
