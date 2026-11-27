// Single source of truth for UI motion. Values mirror the CSS custom properties in
// styles/motion.css so CSS transitions and Motion (JS) animations feel identical.
// macOS-like: short, decelerating curves; no overshoot / bounce anywhere.

export const DUR = {
  fast: 0.12, // hover, press, small state changes
  base: 0.2, // page content, toasts
  slow: 0.32, // modals, larger surfaces
} as const;

/** Standard ease (≈ CSS `ease`), and a decelerating ease-out for things entering. */
export const EASE = [0.25, 0.1, 0.25, 1] as const;
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Critically damped spring: smooth, never bounces. */
export const SPRING = { type: "spring", duration: 0.35, bounce: 0 } as const;

export const page = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE_OUT } },
  exit: { opacity: 0, y: -4, transition: { duration: DUR.fast, ease: EASE } },
};

export const backdrop = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DUR.base, ease: EASE } },
  exit: { opacity: 0, transition: { duration: DUR.fast, ease: EASE } },
};

export const panel = {
  initial: { opacity: 0, scale: 0.97, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: DUR.slow, ease: EASE_OUT } },
  exit: { opacity: 0, scale: 0.98, y: 4, transition: { duration: DUR.fast, ease: EASE } },
};

export const toast = {
  initial: { opacity: 0, y: 12, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: DUR.base, ease: EASE_OUT } },
  exit: { opacity: 0, x: 24, transition: { duration: DUR.fast, ease: EASE } },
};

/** Staggered entrance for lists / grids (cards). Only the first few items are delayed. */
export const STAGGER_STEP = 0.035;
export const STAGGER_MAX = 10;
export const item = {
  initial: { opacity: 0, y: 8 },
  animate: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: DUR.base, ease: EASE_OUT, delay: Math.min(i, STAGGER_MAX) * STAGGER_STEP },
  }),
};
