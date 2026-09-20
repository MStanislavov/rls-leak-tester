import type { Metadata } from "next";
import { DOCS_SECTIONS } from "@/lib/site/docs";
import {
  LimitsSection,
  StaticChecksSection,
  SupabaseModeSection,
  ThreatModelSection,
} from "./sections-reference";
import {
  HowItWorksSection,
  OutcomesSection,
  ProbesSection,
  VerdictSection,
} from "./sections-runner";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "How RLS Leak Tester works: probe semantics, how outcomes and the verdict are decided, the static checks, Supabase mode, the threat model, privacy and limits.",
};

/** One page with anchored sections. The order of the sections is the order of `DOCS_SECTIONS`. */
export default function DocsPage() {
  return (
    <div className="mx-auto grid w-full max-w-6xl flex-1 gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:py-14">
      <nav aria-label="On this page" className="text-sm lg:sticky lg:top-24 lg:self-start">
        <p className="mb-2 font-medium">On this page</p>
        <ol className="flex flex-col gap-1 border-l">
          {DOCS_SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="-ml-px block border-l border-transparent py-1 pl-3 text-muted-foreground hover:border-foreground hover:text-foreground"
              >
                {section.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <main className="flex max-w-3xl min-w-0 flex-col gap-14">
        <header className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">Docs</h1>
          <p className="text-lg leading-relaxed text-muted-foreground">
            What the lab executes, how a cell becomes a pass or a leak, what the verdict means, and
            what the tool cannot tell you.
          </p>
        </header>
        <HowItWorksSection />
        <ProbesSection />
        <OutcomesSection />
        <VerdictSection />
        <StaticChecksSection />
        <SupabaseModeSection />
        <ThreatModelSection />
        <LimitsSection />
      </main>
    </div>
  );
}
