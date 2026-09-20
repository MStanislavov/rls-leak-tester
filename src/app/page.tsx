import { ArrowRight, ClipboardPaste, FileCheck, Play, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { MatrixIllustration } from "@/components/site/matrix-illustration";
import { TemplateCards } from "@/components/site/template-cards";
import { Button } from "@/components/ui/button";
import { getPublicConfig } from "@/lib/config/public";
import { TEMPLATES } from "@/lib/scenario/templates";
import { docsSectionHref } from "@/lib/site/docs";
import { templateCards } from "@/lib/site/templates";

interface Step {
  readonly title: string;
  readonly body: string;
  readonly Icon: LucideIcon;
}

const STEPS: readonly Step[] = [
  {
    title: "Paste schema and personas",
    body: "Your tables with their policies, a few seed rows, and who is asking: a database role and the JWT claims of each persona.",
    Icon: ClipboardPaste,
  },
  {
    title: "Run the matrix in your browser",
    body: "A real Postgres 18 starts inside a Web Worker in this tab. Every persona, table and operation is probed under that persona's role, in a transaction that is rolled back.",
    Icon: Play,
  },
  {
    title: "Export the CI proof",
    body: "The same probes as a plain SQL test and a GitHub Actions workflow, so isolation is proven again on every push.",
    Icon: FileCheck,
  },
];

/**
 * Server Component on purpose. It imports the templates, but only their metadata is rendered
 * (`templateCards`), so no SQL, no PGlite, no editor and no runner reach this page's scripts.
 * e2e/site.spec.ts checks the requests.
 */
export default function HomePage() {
  const { appName } = getPublicConfig();
  const cards = templateCards(TEMPLATES);
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-16 px-4 py-12 sm:px-6 lg:py-16">
      <section className="grid grid-cols-[minmax(0,1fr)] items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-5">
          <h1 className="font-mono text-sm font-medium tracking-wide text-primary uppercase">
            {appName}
          </h1>
          <p className="text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
            Do your row-level security policies actually keep users and tenants apart?
          </p>
          <p className="max-w-prose leading-relaxed text-muted-foreground">
            You write a handful of Postgres or Supabase RLS policies and never prove that user A
            cannot read or change user B&apos;s rows. The failure is silent until it is a breach.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/lab" prefetch={false}>
                Open the lab
                <ArrowRight aria-hidden="true" data-icon="inline-end" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href={docsSectionHref("how-it-works")}>How it works</Link>
            </Button>
          </div>
        </div>
        <MatrixIllustration />
      </section>

      <section aria-labelledby="steps-heading" className="flex flex-col gap-6">
        <h2 id="steps-heading" className="text-xl font-semibold tracking-tight">
          The 20-second explanation
        </h2>
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex flex-col gap-2 rounded-xl border p-4">
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="font-mono text-xs">{`0${index + 1}`}</span>
                <step.Icon aria-hidden="true" className="size-4" />
              </div>
              <h3 className="font-semibold">{step.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section
        aria-labelledby="principle-heading"
        className="flex flex-col gap-3 rounded-xl border-l-4 border-l-primary bg-muted/50 p-6"
      >
        <h2 id="principle-heading" className="text-xl font-semibold tracking-tight">
          Deterministic verdicts, the AI only explains
        </h2>
        <p className="max-w-prose leading-relaxed text-muted-foreground">
          Every pass, leak and verdict comes from executing SQL and comparing row sets. A language
          model never decides whether something is a leak. It may explain a failure the engine
          already proved and propose a fix, and that fix is called verified only after the matrix
          was re-run with it and the failing cells pass.
        </p>
      </section>

      <section aria-labelledby="templates-heading" className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h2 id="templates-heading" className="text-xl font-semibold tracking-tight">
            Try a template
          </h2>
          <p className="text-muted-foreground">
            Each one opens in the lab in its leaky variant, with one real isolation bug to find.
          </p>
        </div>
        <TemplateCards cards={cards} />
      </section>
    </main>
  );
}
