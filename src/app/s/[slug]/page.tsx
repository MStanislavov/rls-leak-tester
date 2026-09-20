import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { sharedPageMeta, toSharedServerResult } from "@/lib/lab/share-page";
import { parseScenarioSlugParams } from "@/lib/store/server";
import { loadSharedScenario } from "@/lib/store/server/next";
import { SharedScenarioLoader } from "./shared-scenario-loader";
import "../../lab/lab.css";

/**
 * A shared scenario, read-only (brief 3.3, 3.10).
 *
 * - `params` is chosen by whoever wrote the link: `parseScenarioSlugParams` validates it with zod
 *   (SEC-002), and a malformed slug names no row, so it is a 404 like a miss.
 * - The scenario comes from the server-side store: the visitor's own session (cookies), row level
 *   security behind it, and the read-through cache for public and unlisted rows. A private
 *   scenario of somebody else is indistinguishable from one that does not exist: 404.
 * - Nothing of the scenario is executed or rendered here. It crosses to the browser as data; the
 *   lab renders it as text and runs its SQL in the visitor's own PGlite worker (brief 4.7).
 * - Without Supabase the page is a 200 that says sharing is not enabled on this deployment (P4:
 *   a calm notice, not an error). The decision is recorded in docs/adr.
 */

/** One load per request, shared by `generateMetadata` and the page. */
const loadBySlug = cache((slug: string) => loadSharedScenario({ ok: true, value: slug }));

async function load(params: PageProps<"/s/[slug]">["params"]) {
  const slug = parseScenarioSlugParams(await params);
  return slug.ok ? { slug: slug.value, result: await loadBySlug(slug.value) } : null;
}

/** Only a public scenario lends its title; everything else is generic and not indexed. */
export async function generateMetadata({ params }: PageProps<"/s/[slug]">): Promise<Metadata> {
  const loaded = await load(params);
  const meta = sharedPageMeta(loaded?.result ?? { status: "not_found" });
  return {
    title: meta.title,
    description: meta.description,
    robots: { index: meta.index, follow: meta.index },
  };
}

export default async function SharedScenarioPage({ params }: PageProps<"/s/[slug]">) {
  const loaded = await load(params);
  const initial = loaded === null ? null : toSharedServerResult(loaded.result);
  if (loaded === null || initial === null) {
    notFound();
  }
  return <SharedScenarioLoader slug={loaded.slug} initial={initial} />;
}
