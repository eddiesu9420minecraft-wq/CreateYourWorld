/** Original line icons (24×24, stroke = currentColor). */
const PATHS: Record<string, string> = {
  home: "M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z",
  apps: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  installed: "M5 4h14v16H5zM9 9l2 2 4-4M9 15h6",
  updates: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
  downloads: "M12 4v11M7 10l5 5 5-5M5 20h14",
  runtime: "M4 6h16v5H4zM4 13h16v5H4zM8 8.5h.01M8 15.5h.01",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.5 7.5 0 0 0-1.7 1l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-.9a7.5 7.5 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 1.7-1l2.3.9 2-3.4z",
  search: "M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM20 20l-4.3-4.3",
  refresh: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
  play: "M8 5l11 7-11 7z",
  pause: "M8 5h3v14H8zM13 5h3v14h-3z",
  close: "M6 6l12 12M18 6L6 18",
  folder: "M3 7h6l2 2h10v10H3z",
  github: "M9 19c-4 1.5-4-2-6-2.5M15 21v-3.5a3 3 0 0 0-.8-2.3c2.7-.3 5.5-1.3 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.5 2.5 5.5 2.8 5.5 2.8a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.2c0 4.7 2.8 5.7 5.5 6a3 3 0 0 0-.8 2.3V21",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  check: "M5 12l5 5 9-10",
  alert: "M12 4l9 16H3zM12 10v4M12 17h.01",
  shield: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z",
  chip: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  retry: "M4 12a8 8 0 0 1 13.66-5.66M20 4v5h-5M20 12a8 8 0 0 1-13.66 5.66M4 20v-5h5",
  terminal: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5",
};

export function Icon({ name, size = 18, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? PATHS.apps} />
    </svg>
  );
}

/** Product artwork: geometric glyphs, never letter monograms. */
export function ProductGlyph({ glyph, size = 56 }: { glyph: string | null; size?: number }) {
  return (
    <div className="glyph" style={{ width: size, height: size }}>
      <svg viewBox="0 0 48 48" width={size * 0.62} height={size * 0.62} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
        {glyph === "runx" ? (
          <>
            {/* runX: a forward chevron (run) beside a solid block (the native binary it produces) */}
            <path d="M9 13l11 11-11 11" strokeWidth={3.2} strokeLinejoin="round" />
            <path d="M19 13l11 11-11 11" strokeWidth={3.2} strokeLinejoin="round" opacity={0.45} />
            <rect x="31" y="17" width="10" height="14" rx="2" fill="currentColor" stroke="none" />
          </>
        ) : glyph === "atom" ? (
          <>
            <circle cx="24" cy="24" r="3.4" fill="currentColor" stroke="none" />
            <ellipse cx="24" cy="24" rx="19" ry="7.5" />
            <ellipse cx="24" cy="24" rx="19" ry="7.5" transform="rotate(60 24 24)" />
            <ellipse cx="24" cy="24" rx="19" ry="7.5" transform="rotate(-60 24 24)" />
          </>
        ) : (
          <path d="M24 6l18 18-18 18L6 24z" />
        )}
      </svg>
    </div>
  );
}
