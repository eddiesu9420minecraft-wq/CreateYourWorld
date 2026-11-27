import type { CSSProperties } from "react";

/**
 * Original Pikara geometric mark: four corner wedges framing a central "world" diamond.
 * Each piece carries a `data-piece` attribute so the splash transition can push the
 * wedges out toward the four corners.
 */
export function PikaraLogo({ size = 64, className, style, title = "pikara" }: {
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={title}
    >
      <defs>
        <linearGradient id="pikara-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFD25A" />
          <stop offset="1" stopColor="#E39B00" />
        </linearGradient>
      </defs>
      <g fill="url(#pikara-gold)">
        <path data-piece="tl" d="M14 14H44L14 44Z" />
        <path data-piece="tr" d="M86 14V44L56 14Z" />
        <path data-piece="br" d="M86 86H56L86 56Z" />
        <path data-piece="bl" d="M14 86V56L44 86Z" />
        <path data-piece="core" d="M50 30L70 50L50 70L30 50Z" />
      </g>
    </svg>
  );
}
