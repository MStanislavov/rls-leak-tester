/**
 * Golden test: the static checks (src/lib/checks) against every template variant. A leaky
 * variant yields exactly the findings its metadata declares, a fixed variant yields none.
 */
import { describe, expect, it } from "vitest";
import { runStaticChecks } from "@/lib/checks";
import { introspect } from "@/lib/runner/introspect";
import { templateVariants } from "@/lib/scenario/templates";
import { loadScenario } from "./helpers";

describe.each(templateVariants().map(({ variant }) => ({ id: variant.scenario.id, variant })))(
  "static checks: $id",
  ({ variant }) => {
    it("finds exactly what the template declares", async () => {
      const engine = await loadScenario(variant.scenario);
      try {
        const catalog = await introspect(engine, ["public"]);
        const findings = runStaticChecks(catalog, variant.scenario).map((finding) => ({
          id: finding.id,
          schema: finding.object.schema,
          table: finding.object.table ?? finding.object.name,
          ...(finding.object.kind === "policy" ? { policy: finding.object.name } : {}),
        }));
        expect(findings).toEqual(variant.expectedStaticChecks);
      } finally {
        await engine.close();
      }
    }, 60_000);
  },
);
