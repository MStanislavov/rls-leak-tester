"use client";

/**
 * Regions that scroll: SQL, JSON and YAML in a `<figure>`, a wide table in a `<section>`.
 *
 * A keyboard user can only scroll a region that takes focus (WCAG 2.1.1, axe
 * `scrollable-region-focusable`), and a region that does not scroll is static text that has no
 * business in the tab order. So the tab stop follows the layout: it is there while the content
 * overflows its box, and it is gone when everything is visible.
 */
import { useCallback, useState, type ReactNode } from "react";

function overflows(node: HTMLElement): boolean {
  return node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight;
}

interface ScrollTabStop {
  readonly ref: (node: HTMLElement | null) => (() => void) | undefined;
  /** `0` while the element scrolls, `undefined` (no attribute) while it does not. */
  readonly tabIndex: 0 | undefined;
}

export function useScrollTabStop(): ScrollTabStop {
  // Until it is measured the region counts as scrolling: the server's HTML, and a page whose
  // script never runs, keep the tab stop.
  const [scrollable, setScrollable] = useState(true);

  const ref = useCallback((node: HTMLElement | null) => {
    if (node === null || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    // A region that holds the focus keeps its tab stop: taking it away would drop the focus to
    // the top of the page, in the middle of a zoom or a resize.
    const measure = (): void => setScrollable(overflows(node) || node === document.activeElement);
    // The box changes: the window, a zoom, a `<details>` that opens. The first call is the
    // observer's own, before the first paint.
    const box = new ResizeObserver(measure);
    box.observe(node);
    // The content changes inside a box that is already at its maximum height.
    const content = new MutationObserver(measure);
    content.observe(node, { childList: true, characterData: true, subtree: true });
    node.addEventListener("blur", measure);
    // A web font that arrives late changes the width of every line.
    void document.fonts.ready.then(measure);
    return () => {
      box.disconnect();
      content.disconnect();
      node.removeEventListener("blur", measure);
    };
  }, []);

  return { ref, tabIndex: scrollable ? 0 : undefined };
}

interface ScrollRegionProps {
  /** Accessible name: "Probe SQL transcript", "The statement that failed", "Cell statuses". */
  readonly label: string;
  /** Sets the overflow and the height; the component adds nothing to it. */
  readonly className: string;
  readonly testId?: string;
  readonly children: ReactNode;
}

/**
 * A code listing that may scroll: SQL, JSON, a YAML file. `<figure>` is the element HTML has for
 * a listing, and it takes a name without a `role`. The figure is the box that scrolls, so the
 * `<pre>` takes the figure's font and its `white-space` (`whitespace-pre` or
 * `whitespace-pre-wrap` in `className`) and is as wide as its longest line, which keeps the
 * figure's padding at the end of a horizontal scroll.
 */
export function CodeListing({ label, className, testId, children }: ScrollRegionProps) {
  const { ref, tabIndex } = useScrollTabStop();
  return (
    <figure
      ref={ref}
      tabIndex={tabIndex}
      aria-label={label}
      data-slot="scroll-region"
      data-testid={testId}
      className={className}
    >
      <pre className="w-fit min-w-full [font-family:inherit] [white-space:inherit]">{children}</pre>
    </figure>
  );
}

/** A named region around content wider than a narrow screen, a table as a rule. */
export function ScrollSection({ label, className, testId, children }: ScrollRegionProps) {
  const { ref, tabIndex } = useScrollTabStop();
  return (
    <section
      ref={ref}
      tabIndex={tabIndex}
      aria-label={label}
      data-slot="scroll-region"
      data-testid={testId}
      className={className}
    >
      {children}
    </section>
  );
}
