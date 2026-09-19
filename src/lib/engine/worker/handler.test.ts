import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createRequestHandler, toCell, toErrorInfo, type WorkerDatabase } from "./handler";
import { isWorkerRequest, isWorkerResponse } from "./protocol";

describe("createRequestHandler against a real PGlite", () => {
  it("starts Postgres once, reports the version and runs multi-statement SQL", async () => {
    let created = 0;
    const handle = createRequestHandler(async () => {
      created += 1;
      return PGlite.create();
    });

    const init = await handle({ id: 1, type: "init" });
    expect(isWorkerResponse(init)).toBe(true);
    expect(init).toMatchObject({ id: 1, ok: true, type: "init" });
    if (!init.ok || init.type !== "init") {
      throw new Error("init failed");
    }
    expect(init.result.version).toContain("PostgreSQL");
    expect(init.result.startupMs).toBeGreaterThanOrEqual(0);

    const exec = await handle({
      id: 2,
      type: "exec",
      sql: `
        create table t (id int primary key, big bigint, at timestamptz, doc jsonb, raw bytea, note text);
        insert into t values (1, 9007199254740993, '2026-01-02T03:04:05Z', '{"a":[1,2]}', '\\xdeadbeef', null);
        select id, big, at, doc, raw, note, true as flag from t;
      `,
    });
    expect(isWorkerResponse(exec)).toBe(true);
    if (!exec.ok || exec.type !== "exec") {
      throw new Error("exec failed");
    }
    expect(exec.results).toHaveLength(3);
    const select = exec.results[2];
    expect(select?.fields.map((field) => field.name)).toEqual([
      "id",
      "big",
      "at",
      "doc",
      "raw",
      "note",
      "flag",
    ]);
    expect(select?.rows).toEqual([
      [1, "9007199254740993", "2026-01-02T03:04:05.000Z", '{"a":[1,2]}', "\\xdeadbeef", null, true],
    ]);
    // Everything that crosses postMessage must survive a structured clone unchanged.
    expect(structuredClone(exec)).toEqual(exec);

    // A second init reuses the same database.
    await handle({ id: 3, type: "init" });
    expect(created).toBe(1);
  }, 60_000);

  it("reports a Postgres error with its SQLSTATE and keeps working", async () => {
    const handle = createRequestHandler(() => PGlite.create());
    const failed = await handle({ id: 1, type: "exec", sql: "select * from does_not_exist" });
    expect(failed).toMatchObject({ id: 1, ok: false, error: { code: "42P01" } });
    expect(isWorkerResponse(failed)).toBe(true);

    const next = await handle({ id: 2, type: "exec", sql: "select 1 as one" });
    expect(next).toMatchObject({ id: 2, ok: true });
  }, 60_000);

  it("filters a non-superuser role through a policy, inside the worker logic", async () => {
    const handle = createRequestHandler(() => PGlite.create());
    const response = await handle({
      id: 1,
      type: "exec",
      sql: `
        create role r nologin;
        create table notes (id int primary key, owner text not null);
        insert into notes values (1, 'alice'), (2, 'bob'), (3, 'alice');
        alter table notes enable row level security;
        create policy p on notes for select to r using (owner = current_setting('app.u', true));
        grant select on notes to r;
        select count(*)::int from notes;
        begin;
        set local role r;
        select set_config('app.u', 'alice', true);
        select id from notes order by id;
        commit;
      `,
    });
    if (!response.ok || response.type !== "exec") {
      throw new Error("exec failed");
    }
    expect(response.results[6]?.rows).toEqual([[3]]);
    expect(response.results[10]?.rows).toEqual([[1], [3]]);
  }, 60_000);
});

describe("createRequestHandler with a scripted database", () => {
  it("answers requests strictly in order", async () => {
    const order: string[] = [];
    const db: WorkerDatabase = {
      async exec(sql) {
        if (sql === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        order.push(sql);
        return [{ rows: [["v"]], fields: [{ name: "c", dataTypeID: 25 }] }];
      },
    };
    const handle = createRequestHandler(async () => db);
    await Promise.all([
      handle({ id: 1, type: "exec", sql: "slow" }),
      handle({ id: 2, type: "exec", sql: "fast" }),
    ]);
    expect(order).toEqual(["select version()", "slow", "fast"]);
  });

  it("retries the start after a failed one", async () => {
    let attempts = 0;
    const handle = createRequestHandler(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("wasm failed to load");
      }
      return { exec: async () => [{ rows: [], fields: [] }] };
    });
    expect(await handle({ id: 1, type: "init" })).toMatchObject({
      ok: false,
      error: { message: "wasm failed to load", code: null },
    });
    expect(await handle({ id: 2, type: "init" })).toMatchObject({
      ok: true,
      result: { version: "" },
    });
    expect(attempts).toBe(2);
  });

  it("wraps a row that is not an array and defaults affectedRows", async () => {
    const handle = createRequestHandler(async () => ({
      exec: async () => [{ rows: ["scalar"], fields: [{ name: "c", dataTypeID: 25 }] }],
    }));
    const response = await handle({ id: 1, type: "exec", sql: "x" });
    expect(response).toMatchObject({ results: [{ rows: [["scalar"]], affectedRows: 0 }] });
  });
});

describe("toCell", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["text", "text"],
    [true, true],
    [42, 42],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [123n, "123"],
    [new Date("2026-01-02T03:04:05Z"), "2026-01-02T03:04:05.000Z"],
    [new Date(Number.NaN), "Invalid Date"],
    [new Uint8Array([0, 255, 16]), "\\x00ff10"],
    [[1, 2n], '[1,"2"]'],
    [{ a: { b: 1 } }, '{"a":{"b":1}}'],
    // Titles use the index: "%j" would JSON.stringify a bigint and throw while collecting.
  ])("case %# becomes a structured-clone-safe cell", (input, expected) => {
    expect(toCell(input)).toBe(expected);
  });
});

describe("toErrorInfo", () => {
  it("keeps the Postgres fields of an error object", () => {
    const error = Object.assign(new Error("boom"), { code: "23505", detail: "d", hint: "h" });
    expect(toErrorInfo(error)).toEqual({
      message: "boom",
      code: "23505",
      detail: "d",
      hint: "h",
      position: null,
    });
  });

  it("copes with values that are not errors", () => {
    expect(toErrorInfo("plain")).toMatchObject({ message: "plain", code: null });
    expect(toErrorInfo({ code: 7 })).toMatchObject({ message: "[object Object]", code: null });
  });
});

describe("protocol guards", () => {
  it("accepts well-formed requests and rejects the rest", () => {
    expect(isWorkerRequest({ id: 1, type: "init" })).toBe(true);
    expect(isWorkerRequest({ id: 1, type: "exec", sql: "select 1" })).toBe(true);
    expect(isWorkerRequest({ id: 1, type: "exec" })).toBe(false);
    expect(isWorkerRequest({ id: "1", type: "init" })).toBe(false);
    expect(isWorkerRequest({ id: 1, type: "drop" })).toBe(false);
    expect(isWorkerRequest(null)).toBe(false);
  });

  it("accepts well-formed responses and rejects the rest", () => {
    expect(isWorkerResponse({ id: 1, ok: false, error: { message: "m" } })).toBe(true);
    expect(isWorkerResponse({ id: 1, ok: false, error: "m" })).toBe(false);
    expect(isWorkerResponse({ id: 1, ok: true, type: "init", result: { version: "v" } })).toBe(
      true,
    );
    expect(isWorkerResponse({ id: 1, ok: true, type: "init", result: {} })).toBe(false);
    expect(isWorkerResponse({ id: 1, ok: true, type: "exec", results: [] })).toBe(true);
    expect(isWorkerResponse({ id: 1, ok: true, type: "exec" })).toBe(false);
    expect(isWorkerResponse({ id: 1, type: "exec", results: [] })).toBe(false);
    expect(isWorkerResponse(undefined)).toBe(false);
  });
});
