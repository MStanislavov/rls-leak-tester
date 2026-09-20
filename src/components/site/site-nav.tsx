"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, REPO_URL, isActivePath } from "@/lib/site/links";
import { cn } from "@/lib/utils";

const LINK_CLASSES =
  "inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground";

/** Client Component only because the current page is marked with `aria-current`. */
export function SiteNav({ className }: { readonly className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className={cn("flex items-center gap-1", className)}>
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          prefetch={item.prefetch ? null : false}
          aria-current={isActivePath(pathname, item.href) ? "page" : undefined}
          className={LINK_CLASSES}
        >
          {item.label}
        </Link>
      ))}
      <a href={REPO_URL} rel="noreferrer" className={LINK_CLASSES}>
        GitHub
        <ArrowUpRight aria-hidden="true" className="size-3.5" />
      </a>
    </nav>
  );
}
