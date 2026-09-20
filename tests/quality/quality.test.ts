/**
 * The stage runner behind `npm run quality`: order, fail-fast, exit codes and what the last lines
 * say. The stages here are fake commands (small Node processes), never the real gate.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildStages,
  execCommand,
  main,
  parseArgs,
  provideRedis,
  runStages,
  SONAR_SETUP,
  summarize,
} from "../../scripts/quality.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/quality.mjs");

let dir = "";
let journal = "";
let logged: string[] = [];
let clock = 0;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "quality-"));
  journal = path.join(dir, "journal.txt");
  logged = [];
  clock = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const io = {
  log: (line: string) => logged.push(line),
  exec: (command: readonly string[], env: Record<string, string>) =>
    execCommand(command, env, "ignore"),
  now: () => (clock += 1500),
};

/** A stage whose command appends its id (and one environment variable) to the journal. */
function fake(id: string, exitCode = 0, extra: Record<string, unknown> = {}) {
  const code = `require("node:fs").appendFileSync(${JSON.stringify(journal)}, ${JSON.stringify(id)} + ":" + (process.env.QUALITY_FAKE ?? "-") + "\\n"); process.exit(${exitCode});`;
  return {
    id,
    title: `fake stage ${id}`,
    command: [process.execPath, "-e", code],
    rerun: `run-${id}-alone`,
    ...extra,
  };
}
const written = () => readFileSync(journal, "utf8").trim().split("\n");

describe("runStages", () => {
  it("runs every stage once, in the given order, with a banner per stage", async () => {
    const result = await runStages([fake("one"), fake("two"), fake("three")], io);
    expect(written()).toEqual(["one:-", "two:-", "three:-"]);
    expect(result).toMatchObject({ ok: true, failed: null, total: 3 });
    expect(result.results).toEqual([
      { id: "one", code: 0, ms: 1500 },
      { id: "two", code: 0, ms: 1500 },
      { id: "three", code: 0, ms: 1500 },
    ]);
    expect(logged.filter((line) => line.startsWith("==="))).toEqual([
      "=== quality 1/3: fake stage one ===",
      "=== quality 2/3: fake stage two ===",
      "=== quality 3/3: fake stage three ===",
    ]);
  });

  it("stops at the first failing stage and reports its exit code", async () => {
    const result = await runStages([fake("one"), fake("two", 3), fake("three")], io);
    expect(written()).toEqual(["one:-", "two:-"]);
    expect(result.ok).toBe(false);
    expect(result.failed).toMatchObject({ index: 1, code: 3, stage: { id: "two" } });
    expect(result.results.map((entry) => entry.id)).toEqual(["one", "two"]);
  });

  it("hands the environment and the notes of before() to the stage", async () => {
    const before = async () => ({ env: { QUALITY_FAKE: "from-before" }, notes: ["a note"] });
    const result = await runStages([fake("one", 0, { before }), fake("two")], io);
    expect(result.ok).toBe(true);
    expect(written()).toEqual(["one:from-before", "two:-"]);
    expect(logged).toContain("    a note");
  });

  it("fails the stage when before() throws, without running its command", async () => {
    const before = async () => {
      throw new Error("no redis today");
    };
    const result = await runStages([fake("one", 0, { before }), fake("two")], io);
    expect(result.failed).toMatchObject({ index: 0, code: 1 });
    expect(logged).toContain("    no redis today");
    expect(() => readFileSync(journal, "utf8")).toThrow();
  });

  it("reports 127 for a command that cannot be started", async () => {
    const stage = { ...fake("ghost"), command: [path.join(dir, "no-such-program")] };
    const result = await runStages([stage, fake("after")], io);
    expect(result.failed).toMatchObject({ index: 0, code: 127 });
  });
});

describe("summarize", () => {
  it("names the failed stage, its number, its exit code and how to run it alone", async () => {
    const stages = [
      fake("one"),
      fake("two", 3, { hint: "read the log" }),
      fake("three"),
      fake("4"),
    ];
    const { lines, exitCode } = summarize(await runStages(stages, io), { sonar: true });
    expect(exitCode).toBe(1);
    expect(lines).toContain('quality: FAILED at stage 2/4 "two": fake stage two (exit code 3).');
    expect(lines).toContain("quality: 2 later stages were not run.");
    expect(lines).toContain("quality: run this stage alone with: run-two-alone");
    expect(lines).toContain("quality: read the log");
    expect(lines).toContain("  ok     one                  1.5s");
    expect(lines).toContain("  FAILED two                  1.5s");
  });

  it("passes only when every stage passed and the Sonar gate was part of the run", async () => {
    const result = await runStages([fake("one"), fake("two")], io);
    expect(summarize(result, { sonar: true })).toMatchObject({ exitCode: 0 });
    expect(summarize(result, { sonar: true }).lines.at(-1)).toBe(
      "quality: PASSED, all 2 stages, Sonar quality gate included.",
    );
  });

  it("says that the gate was NOT fully run when Sonar was left out", async () => {
    const { lines, exitCode } = summarize(await runStages([fake("one")], io), { sonar: false });
    expect(exitCode).toBe(0);
    expect(lines.at(-1)).toMatch(/NOT fully run/);
    expect(lines.at(-1)).toMatch(/--no-sonar/);
    expect(lines.join("\n")).not.toMatch(/PASSED/);
  });

  it("still fails with --no-sonar when another stage failed", async () => {
    const result = await runStages([fake("one", 1)], io);
    expect(summarize(result, { sonar: false }).exitCode).toBe(1);
  });
});

describe("the real stage list", () => {
  it("is the order of the brief, framed by the two Sonar stages", () => {
    expect(buildStages({ sonar: true }).map((stage) => stage.id)).toEqual([
      "sonar-preflight",
      "format",
      "lint",
      "typecheck",
      "rules",
      "unit",
      "build",
      "e2e",
      "sonar",
    ]);
  });

  it("drops only the Sonar stages with --no-sonar", () => {
    expect(buildStages({ sonar: false }).map((stage) => stage.id)).toEqual([
      "format",
      "lint",
      "typecheck",
      "rules",
      "unit",
      "build",
      "e2e",
    ]);
  });

  it("tells how to start and bootstrap the server when the preflight fails", () => {
    const preflight = buildStages({ sonar: true })[0];
    for (const command of SONAR_SETUP) expect(preflight?.hint).toContain(command);
    expect(SONAR_SETUP.join("\n")).toMatch(/docker compose up -d --wait sonarqube/);
    expect(SONAR_SETUP.join("\n")).toMatch(/npm run sonar:bootstrap/);
  });

  it("runs the unit tests through the npm script and every stage has a way to run it alone", () => {
    const stages = buildStages({ sonar: true });
    expect(stages.find((stage) => stage.id === "unit")?.command).toEqual([
      "npm",
      "run",
      "test:coverage",
    ]);
    expect(stages.find((stage) => stage.id === "sonar")?.command).toEqual(["npm", "run", "sonar"]);
    for (const stage of stages) expect(stage.rerun).not.toBe("");
  });
});

describe("provideRedis", () => {
  it("keeps a REDIS_URL that is already set", async () => {
    const calls: string[] = [];
    const probe = (program: string, args: string[]) => calls.push([program, ...args].join(" "));
    const prepared = await provideRedis(probe, { REDIS_URL: "redis://elsewhere:6379" });
    expect(prepared.env).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("runs hermetically and says so when Docker is not available", async () => {
    const prepared = await provideRedis(() => 1, {});
    expect(prepared.env).toBeUndefined();
    expect(prepared.notes.join(" ")).toMatch(/Docker is not available/);
    expect(prepared.notes.join(" ")).toMatch(/hermetic/);
  });

  it("starts redis and sets REDIS_URL when Docker is available", async () => {
    const calls: string[] = [];
    const probe = (program: string, args: string[]) => {
      calls.push([program, ...args].join(" "));
      return 0;
    };
    const prepared = await provideRedis(probe, { REDIS_URL: " " });
    expect(calls).toEqual(["docker info", "docker compose up -d --wait redis"]);
    expect(prepared.env).toEqual({ REDIS_URL: "redis://127.0.0.1:6379" });
  });

  it("fails the stage when redis does not come up", async () => {
    const probe = (_program: string, args: string[]) => (args[0] === "info" ? 0 : 1);
    await expect(provideRedis(probe, {})).rejects.toThrow(/docker compose up/);
  });
});

describe("main", () => {
  it("passes the options to the stage list and returns the exit code", async () => {
    const seen: boolean[] = [];
    const stages = (options: { sonar: boolean }) => {
      seen.push(options.sonar);
      return [fake("one")];
    };
    expect(await main([], { io, stages })).toBe(0);
    expect(await main(["--no-sonar"], { io, stages })).toBe(0);
    expect(seen).toEqual([true, false]);
    expect(logged.at(-1)).toMatch(/NOT fully run/);
    expect(await main([], { io, stages: () => [fake("one"), fake("two", 9)] })).toBe(1);
  });

  it("refuses an unknown argument with exit code 2 and runs nothing", async () => {
    expect(await main(["--skip-tests"], { io, stages: () => [fake("one")] })).toBe(2);
    expect(() => readFileSync(journal, "utf8")).toThrow();
    expect(() => parseArgs(["--fast"])).toThrow(/unknown argument/);
    expect(parseArgs(["--no-sonar"])).toEqual({ sonar: false, help: false });
  });

  it("as a process: --help exits 0 and lists the stages, an unknown flag exits 2", () => {
    const help = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(
      "sonar-preflight, format, lint, typecheck, rules, unit, build, e2e, sonar",
    );
    const bogus = spawnSync(process.execPath, [SCRIPT, "--bogus"], { encoding: "utf8" });
    expect(bogus.status).toBe(2);
    expect(bogus.stdout).toMatch(/unknown argument "--bogus"/);
  });
});
