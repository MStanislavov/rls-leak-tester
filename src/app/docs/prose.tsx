import type { ReactNode } from "react";
import { CodeListing } from "@/components/site/scroll-region";
import { DOCS_SECTIONS, type DocsSectionId } from "@/lib/site/docs";
import { cn } from "@/lib/utils";

/** Building blocks of the docs page. Text only: nothing here renders HTML from a string. */

function sectionTitle(id: DocsSectionId): string {
  return DOCS_SECTIONS.find((section) => section.id === id)?.title ?? id;
}

interface DocSectionProps {
  readonly id: DocsSectionId;
  readonly children: ReactNode;
}

/** The title comes from `DOCS_SECTIONS`, so the table of contents and the headings cannot differ. */
export function DocSection({ id, children }: DocSectionProps) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="flex flex-col gap-4">
      <h2 id={`${id}-heading`} className="text-2xl font-semibold tracking-tight">
        {sectionTitle(id)}
      </h2>
      {children}
    </section>
  );
}

export function H3({ id, children }: { readonly id?: string; readonly children: ReactNode }) {
  return (
    <h3 id={id} className="mt-2 text-lg font-semibold tracking-tight">
      {children}
    </h3>
  );
}

export function P({ children }: { readonly children: ReactNode }) {
  return <p className="leading-relaxed text-foreground/90">{children}</p>;
}

export function Ul({ children }: { readonly children: ReactNode }) {
  return (
    <ul className="flex list-disc flex-col gap-2 pl-5 leading-relaxed text-foreground/90 marker:text-muted-foreground">
      {children}
    </ul>
  );
}

export function Ol({ children }: { readonly children: ReactNode }) {
  return (
    <ol className="flex list-decimal flex-col gap-2 pl-5 leading-relaxed text-foreground/90 marker:font-mono marker:text-sm marker:text-muted-foreground">
      {children}
    </ol>
  );
}

/** SQL, keys, roles and SQLSTATEs are monospace everywhere. */
export function Code({ children }: { readonly children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] break-words">
      {children}
    </code>
  );
}

export function Sql({ label, children }: { readonly label: string; readonly children: string }) {
  return (
    <CodeListing
      label={label}
      className="overflow-x-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed whitespace-pre"
    >
      <code>{children}</code>
    </CodeListing>
  );
}

export function DocLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}) {
  return (
    <a
      href={href}
      rel="noreferrer"
      className="font-medium text-primary underline underline-offset-4 hover:no-underline"
    >
      {children}
    </a>
  );
}

export function Note({
  title,
  children,
  className,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-lg border-l-4 border-l-primary bg-muted/50 p-4 text-sm leading-relaxed",
        className,
      )}
    >
      <p className="font-semibold">{title}</p>
      <div className="text-foreground/90">{children}</div>
    </div>
  );
}
