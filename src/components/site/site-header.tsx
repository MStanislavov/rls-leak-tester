import Link from "next/link";
import { AuthControls } from "@/components/auth/auth-controls";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { getPublicConfig } from "@/lib/config/public";
import { SiteNav } from "./site-nav";

/** A 3 x 3 matrix with one failing cell. Decorative: the product name stands next to it. */
function Mark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18" className="size-[18px] shrink-0">
      {[0, 1, 2].flatMap((row) =>
        [0, 1, 2].map((column) => {
          const failing = row === 1 && column === 2;
          return (
            <rect
              key={`${row}-${column}`}
              x={column * 6.5}
              y={row * 6.5}
              width="5"
              height="5"
              rx="1"
              className={failing ? "fill-status-leak" : "fill-foreground/70"}
            />
          );
        }),
      )}
    </svg>
  );
}

interface SiteHeaderProps {
  readonly appName: string;
}

export function SiteHeader({ appName }: SiteHeaderProps) {
  // Sign-in exists only on a deployment with Supabase (brief 3.10, 4.8); without it the header
  // renders exactly what it rendered before and ships no auth code.
  const { supabaseEnabled } = getPublicConfig();
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex min-h-14 w-full max-w-[90rem] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-md text-sm font-semibold tracking-tight"
        >
          <Mark />
          {appName}
        </Link>
        <SiteNav className="order-3 w-full sm:order-none sm:ml-2 sm:w-auto" />
        <div className="ml-auto flex items-center gap-2">
          {supabaseEnabled ? <AuthControls /> : null}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
