interface BrandMarkProps {
  /** Rendered edge of the (square) canvas; the spectrum inside is the mark. */
  height?: number;
  /** When given, the mark is announced as an image rather than hidden from
   *  assistive tech — the sidebar next to the visible 方册 hides it, a logo
   *  standing alone in the About card names itself. */
  label?: string;
}

/**
 * The 方册 mark on its own: a five-bar muted spectrum, no wordmark.
 *
 * One source of truth for the drawing — the sidebar wordmark and the About
 * card's logo are the same rects, so they cannot drift apart. The canvas is
 * square but the bars themselves are a wide rectangle; the squircle app icon
 * in the Dock is the bundle PNG and deliberately not reused here.
 */
export function BrandMark({ height = 22, label }: BrandMarkProps) {
  return (
    <svg
      width={height}
      height={height}
      viewBox="0 0 22 22"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="shrink-0"
    >
      <rect x="2" y="4" width="18" height="2.4" rx="1.2" fill="#F0A93B" />
      <rect x="2" y="8.2" width="18" height="2.4" rx="1.2" fill="#E0735C" />
      <rect x="2" y="12.4" width="18" height="2.4" rx="1.2" fill="#B0679B" />
      <rect x="2" y="16.6" width="18" height="2.4" rx="1.2" fill="#5C7FBF" />
      <rect x="2" y="16.6" width="10" height="2.4" rx="1.2" fill="#4FA89B" />
    </svg>
  );
}
