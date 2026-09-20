/** The id of the wrapper the root layout puts around every page. */
export const CONTENT_ID = "content";

/** First focusable element of every page: hidden until it receives keyboard focus. */
export function SkipLink() {
  return (
    <a
      href={`#${CONTENT_ID}`}
      className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-primary focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm focus-visible:font-medium focus-visible:text-primary-foreground"
    >
      Skip to content
    </a>
  );
}
