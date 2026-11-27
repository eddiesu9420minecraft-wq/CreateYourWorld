/**
 * React bindings for pikara-splash. Thin wrappers only — all behaviour lives in ./pikara-splash.ts.
 */
import { useId, useLayoutEffect, useRef, type CSSProperties } from "react";
import { LOGO_GRADIENT, LOGO_PIECES, mountReveal, mountSplash, type RevealOptions, type SplashOptions } from "./pikara-splash";

export * from "./pikara-splash";

/** The Pikara mark as a React element (same geometry as `logoSvg`). */
export function PikaraLogo({ size = 64, className, style, title = "pikara" }: { size?: number; className?: string; style?: CSSProperties; title?: string }) {
  const id = `pkg${useId().replace(/:/g, "")}`;
  return (
    <svg className={className} style={style} width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={title}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={LOGO_GRADIENT[0]} />
          <stop offset="1" stopColor={LOGO_GRADIENT[1]} />
        </linearGradient>
      </defs>
      <g fill={`url(#${id})`}>
        {LOGO_PIECES.map(([p, d]) => <path key={p} data-piece={p} d={d} />)}
      </g>
    </svg>
  );
}

/** Whole splash window. Options are read once, at mount. */
export function SplashScreen(props: SplashOptions) {
  const ref = useRef<HTMLDivElement>(null);
  const opts = useRef(props);
  useLayoutEffect(() => mountSplash(ref.current!, opts.current), []);
  return <div ref={ref} />;
}

/**
 * Main-window reveal overlay. Mounted with useLayoutEffect so it is painted in the very first
 * commit, before the (hidden) window is shown — timers and rAF are throttled in hidden windows.
 */
export function RevealOverlay(props: RevealOptions) {
  const opts = useRef(props);
  useLayoutEffect(() => mountReveal(document.body, opts.current), []);
  return null;
}
