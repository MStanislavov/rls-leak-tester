/**
 * P5 on the templates: a whole matrix run leaves the database as it found it. The leaky variants
 * are the hard case, because their writes really go through (template 1 moves every project of a
 * tenant, the service role deletes whole tables with cascading foreign keys) and only the
 * rollback undoes them. In the app's own template the service role may touch nothing; there the
 * owners' deletes are the writes that are rolled back.
 */
import { describe, expect, it } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import type { SqlEngine } from "@/lib/runner/types";
import { templateVariants } from "@/lib/scenario/templates";
import { dumpDatabase, run } from "../runner/helpers";

const OWN_TEMPLATE = "own-scenarios-table";

const VARIANTS = templateVariants().map(({ variant }) => ({ id: variant.scenario.id, variant }));

describe.each(VARIANTS)("the database after a run: $id", ({ variant }) => {
  it("dumps identically before the first probe and after the last", async () => {
    const engine = await createPgliteEngine();
    let before: string | undefined;
    const observed: SqlEngine = {
      ...engine,
      // The first transaction is the first probe: setup, introspection and ground truth are done.
      transaction: async (callback) => {
        before ??= await dumpDatabase(engine);
        return engine.transaction(callback);
      },
      // The run closes what it created; the dump afterwards needs the database alive.
      close: () => Promise.resolve(),
    };
    try {
      const { result, timings } = await run(variant.scenario, {
        createEngine: () => Promise.resolve(observed),
      });
      expect(timings.rebuilds).toBe(0);
      // The run did write inside its transactions: every DELETE cell that expects rows reached
      // some. In the demos the service role deletes whole tables; in the app's own schema it
      // holds no privilege (scope `none`), and the owners are the ones whose deletes go through.
      const deletes = result.cells.filter((cell) => cell.operation === "delete");
      const serviceDeletes = deletes.filter((cell) => cell.personaId === "service");
      expect(serviceDeletes.length).toBeGreaterThan(0);
      for (const cell of serviceDeletes) {
        expect(cell.scope, cell.id).toBe(
          variant.scenario.id.startsWith(OWN_TEMPLATE) ? "none" : "all",
        );
      }
      const writers = deletes.filter((cell) => cell.expectedKeys.length > 0);
      expect(writers.length).toBeGreaterThan(0);
      for (const cell of writers) {
        expect(cell.actualKeys.length, cell.id).toBeGreaterThan(0);
      }
      for (const cell of serviceDeletes.filter((candidate) => candidate.scope === "all")) {
        expect(cell.actualKeys.length, cell.id).toBeGreaterThan(0);
      }

      const after = await dumpDatabase(engine);
      expect(before).toBeDefined();
      expect(after).toBe(before);
      const { rows } = await engine.query("select current_user::text as role");
      expect(rows).toEqual([{ role: "postgres" }]);
    } finally {
      await engine.close();
    }
  }, 120_000);
});
