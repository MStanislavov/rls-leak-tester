import { describe, expect, it } from "vitest";
import type { CellPlanContext } from "@/lib/runner";
import { volatileKeyAdvice, volatileKeyOf, volatileKeyWarning } from "./volatile-keys";

type Input = Pick<CellPlanContext, "table" | "truth">;

const column = (name: string, type: string, expression: string | null) => ({
  name,
  position: 1,
  type,
  notNull: true,
  default: expression,
  generated: null,
  generationExpression: null,
  identity: null,
});

function input(
  columns: ReturnType<typeof column>[],
  primaryKey: string[],
  keys: string[][],
): Input {
  return {
    table: {
      schema: "public",
      name: "todos",
      owner: "postgres",
      rlsEnabled: true,
      rlsForced: false,
      partitioned: false,
      columns,
      primaryKey,
    },
    truth: {
      status: "ok",
      schema: "public",
      name: "todos",
      primaryKey,
      ownerColumn: null,
      tenantColumn: null,
      rows: keys.map((key) => ({ key: JSON.stringify(key), owner: null, tenant: null })),
    },
  };
}

const UUID = "0b0f7b5e-6d0c-4a59-9d53-3f0c3c4f7a11";

describe("volatileKeyOf", () => {
  it("a key that is nowhere in the SQL, under a default that is not a sequence", () => {
    const todos = input([column("id", "uuid", "gen_random_uuid()")], ["id"], [[UUID]]);
    expect(volatileKeyOf(todos, "insert into todos (title) values ('a')")).toEqual({
      table: "public.todos",
      column: "id",
      expression: "gen_random_uuid()",
    });
  });

  it("a key the seed spells out is reproducible, whatever the default and the letter case", () => {
    const todos = input([column("id", "uuid", "gen_random_uuid()")], ["id"], [[UUID]]);
    expect(
      volatileKeyOf(todos, `insert into todos (id) values ('${UUID.toUpperCase()}')`),
    ).toBeNull();
  });

  it("no default, a sequence, or a column the catalog does not list: reproducible", () => {
    const sql = "insert into todos (title) values ('a')";
    expect(volatileKeyOf(input([column("id", "integer", null)], ["id"], [["41"]]), sql)).toBeNull();
    expect(
      volatileKeyOf(
        input([column("id", "integer", "nextval('todos_id_seq'::regclass)")], ["id"], [["41"]]),
        sql,
      ),
    ).toBeNull();
    expect(volatileKeyOf(input([], ["id"], [["41"]]), sql)).toBeNull();
  });

  it("a composite key: the column with the volatile default is the one that is named", () => {
    const events = input(
      [column("tenant_id", "integer", null), column("at", "timestamp with time zone", "now()")],
      ["tenant_id", "at"],
      [["1", "2026-09-20 03:00:00.123+00"]],
    );
    expect(volatileKeyOf(events, "insert into todos (tenant_id) values (1)")?.column).toBe("at");
    expect(volatileKeyOf(input([], [], []), "")).toBeNull();
    // A key with fewer values than the primary key has columns: nothing to look for, no claim.
    const short = input([column("at", "timestamp with time zone", "now()")], ["id", "at"], [["1"]]);
    expect(volatileKeyOf(short, "")).toBeNull();
  });

  it("keeps a long or multi-line default on one readable line", () => {
    const expression = `md5((random())::text ||\n ${"x".repeat(200)})`;
    const found = volatileKeyOf(input([column("id", "text", expression)], ["id"], [["f00"]]), "");
    expect(found?.expression).toHaveLength(83);
    expect(found?.expression).toMatch(/^md5\(\(random\(\)\)::text \|\| +x+\.\.\.$/);
  });
});

describe("the sentences", () => {
  const found = { table: "public.todos", column: "id", expression: "gen_random_uuid()" };

  it("the warning says what will happen and what to do", () => {
    expect(volatileKeyWarning(found)).toMatch(
      /^public\.todos: .* key column id defaults to gen_random_uuid\(\), .* Give the seed explicit keys/,
    );
  });

  it("the advice of the failed seed check names the cause and ends with a full stop", () => {
    expect(volatileKeyAdvice(found)).toMatch(
      /^The key column id defaults to gen_random_uuid\(\) .* differ on every load.* export the check again\.$/,
    );
  });
});
