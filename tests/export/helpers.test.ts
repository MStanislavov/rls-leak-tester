/**
 * The comparator of the export suites reads the final exception back into cells. A cell id is
 * `persona|schema.table|operation`, and a quoted table name may hold a space, a parenthesis or a
 * bracket, as the persona's label after it may: the id is found by what the run knows, never by
 * splitting the line at a character.
 */
import { describe, expect, it } from "vitest";
import { SqlError } from "@/lib/runner/types";
import { failedCells } from "./helpers";

function exception(lines: readonly string[]): SqlError {
  return new SqlError({
    code: "P0001",
    message: ["RLS Leak Tester: LEAKING. 2 of 4 checked cells ...", ...lines].join("\n"),
  });
}

describe("failedCells", () => {
  const ids = [
    "alice|public.notes|select",
    "alice|App Data.Order Items|select",
    "alice|App Data.Order Items|select (old)|update",
    'bob|public.Odd "Table|delete',
  ];

  it("reads an id that holds spaces, and a label that holds parentheses", () => {
    const lines = [
      '[leak] alice|App Data.Order Items|select (Alice (owns three) as role "app user": SELECT): leaked keys [["2"]]; missing keys none',
      '[overblock] bob|public.Odd "Table|delete (Bob): leaked keys none; missing keys [["1"]]',
      "[leak] alice|public.notes|select (Alice): leaked keys none; missing keys none",
    ];

    expect(failedCells(exception(lines), ids).map(({ status, id }) => [status, id])).toEqual([
      ["leak", "alice|App Data.Order Items|select"],
      ["overblock", 'bob|public.Odd "Table|delete'],
      ["leak", "alice|public.notes|select"],
    ]);
  });

  it("prefers the longest known id when one id is the beginning of another", () => {
    const [cell] = failedCells(
      exception([
        "[escape] alice|App Data.Order Items|select (old)|update (Alice): leaked keys none; missing keys none",
      ]),
      ids,
    );

    expect(cell).toMatchObject({
      status: "escape",
      id: "alice|App Data.Order Items|select (old)|update",
    });
  });

  it("keeps a line that is not about a cell, with an empty id", () => {
    const [setup, unknown] = failedCells(
      exception([
        "[setup] the table public.invoices is not covered by this file",
        "[leak] carol|public.other|select (Carol): leaked keys none; missing keys none",
      ]),
      ids,
    );

    expect(setup).toMatchObject({ status: "setup", id: "" });
    expect(unknown).toMatchObject({ status: "leak", id: "" });
  });
});
