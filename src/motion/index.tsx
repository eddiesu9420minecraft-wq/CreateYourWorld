import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, LazyMotion, MotionConfig, m } from "motion/react";
import type { UiMotion } from "../api";
import { backdrop, item, page, panel, toast } from "./tokens";

/** True when animations must not run: setting "off", or "system" with OS reduce-motion on. */
const MotionOff = createContext(false);
export const useMotionOff = () => useContext(MotionOff);

// Same shapes as the variants, but every state is reached instantly.
const INSTANT = { initial: {}, animate: { opacity: 1, x: 0, y: 0, scale: 1, transition: { duration: 0 } }, exit: { opacity: 0, transition: { duration: 0 } } };
const pick = <T,>(off: boolean, v: T) => (off ? (INSTANT as unknown as T) : v);

function usePrefersReduced() {
  const q = "(prefers-reduced-motion: reduce)";
  const [r, setR] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const f = () => setR(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return r;
}

/** `m` + LazyMotion keeps only the animation features we use in the bundle. */
export { AnimatePresence, m as motion };
export * from "./tokens";

/**
 * Applies the user's animation preference app-wide:
 *  - "system": follow the OS "reduce motion" setting (prefers-reduced-motion)
 *  - "on":     always animate
 *  - "off":    no animations (JS and CSS)
 * CSS reads `html[data-motion]`; Motion reads `reducedMotion`.
 */
export function MotionProvider({ mode, children }: { mode: UiMotion; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.dataset.motion = mode;
  }, [mode]);
  const prefersReduced = usePrefersReduced();
  const off = mode === "off" || (mode === "system" && prefersReduced);
  return (
    <MotionOff.Provider value={off}>
      <LazyMotion features={loadFeatures} strict>
        <MotionConfig reducedMotion={off ? "always" : "never"} transition={off ? { duration: 0 } : undefined}>{children}</MotionConfig>
      </LazyMotion>
    </MotionOff.Provider>
  );
}

const loadFeatures = () => import("./features").then((r) => r.default);

/** Page content cross-fade with a slight vertical drift. Keyed by page id. */
export function PageTransition({ id, children }: { id: string; children: ReactNode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <m.div key={id} variants={pick(useMotionOff(), page)} initial="initial" animate="animate" exit="exit">
        {children}
      </m.div>
    </AnimatePresence>
  );
}

/** One staggered list item (cards, rows). `index` controls the small entrance delay. */
export function StaggerItem({ index, className, children }: { index: number; className?: string; children: ReactNode }) {
  return (
    <m.div className={className} variants={pick(useMotionOff(), item)} custom={index} initial="initial" animate="animate">
      {children}
    </m.div>
  );
}

export function MotionBackdrop({ className, onMouseDown, children }: { className: string; onMouseDown?: (e: React.MouseEvent) => void; children: ReactNode }) {
  return (
    <m.div className={className} variants={pick(useMotionOff(), backdrop)} initial="initial" animate="animate" exit="exit" onMouseDown={onMouseDown}>
      {children}
    </m.div>
  );
}

export function MotionPanel({ className, children }: { className: string; children: ReactNode }) {
  return (
    <m.div className={className} role="dialog" variants={pick(useMotionOff(), panel)} initial="initial" animate="animate" exit="exit">
      {children}
    </m.div>
  );
}

export function MotionToast({ className, onClick, children }: { className: string; onClick?: () => void; children: ReactNode }) {
  return (
    <m.div layout={!useMotionOff()} className={className} onClick={onClick} variants={pick(useMotionOff(), toast)} initial="initial" animate="animate" exit="exit">
      {children}
    </m.div>
  );
}
