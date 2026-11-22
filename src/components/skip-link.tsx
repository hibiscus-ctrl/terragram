/**
 * Keyboard "skip to content" link — visually hidden until focused, then pinned
 * top-left. Lets keyboard and screen-reader users jump past the header/sidebar
 * straight to `#main-content` (set on the `<main>` of each section layout).
 */
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only rounded-lg font-semibold focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:text-foreground focus:shadow-lg focus:ring-[3px] focus:ring-ring/40 focus:outline-none"
    >
      Skip to main content
    </a>
  );
}
