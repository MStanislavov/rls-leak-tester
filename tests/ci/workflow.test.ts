/**
 * Pins the essential structure of `.github/workflows/ci.yml` and `.github/dependabot.yml`
 * (brief 5.3). Both files are parsed, not grepped: the assertions are about what GitHub will
 * run. What cannot be checked here is a run on GitHub's runners; `actionlint` checks the syntax
 * and the expressions, `docs/adr` records the local rehearsal of the self-isolation job.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { POSTGRES_IMAGE } from "@/lib/export";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (file: string): string => readFileSync(path.join(ROOT, file), "utf8");

const stepSchema = z.strictObject({
  name: z.string(),
  id: z.string().optional(),
  if: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  env: z.record(z.string(), z.string()).optional(),
  run: z.string().optional(),
});

const serviceSchema = z.strictObject({
  image: z.string(),
  env: z.record(z.string(), z.string()).optional(),
  ports: z.array(z.string()),
  options: z.string(),
});

/** Strict: a key that is not listed here (`continue-on-error`, `permissions`, ...) fails. */
const jobSchema = z.strictObject({
  name: z.string(),
  needs: z.string().optional(),
  if: z.string().optional(),
  "runs-on": z.literal("ubuntu-24.04"),
  "timeout-minutes": z.number().int().positive(),
  services: z.record(z.string(), serviceSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  steps: z.array(stepSchema).min(1),
});

const workflowSchema = z.strictObject({
  name: z.string(),
  on: z.strictObject({
    push: z.strictObject({ branches: z.array(z.string()) }),
    pull_request: z.null(),
  }),
  concurrency: z.strictObject({ group: z.string(), "cancel-in-progress": z.literal(true) }),
  permissions: z.strictObject({ contents: z.literal("read") }),
  defaults: z.strictObject({ run: z.strictObject({ shell: z.literal("bash") }) }),
  env: z.record(z.string(), z.string()),
  jobs: z.record(z.string(), jobSchema),
});

type Job = z.infer<typeof jobSchema>;
type Step = z.infer<typeof stepSchema>;

const workflowText = read(".github/workflows/ci.yml");
const workflow = workflowSchema.parse(parse(workflowText));

function jobOf(id: string): Job {
  const job = workflow.jobs[id];
  if (job === undefined) throw new Error(`ci.yml has no job "${id}"`);
  return job;
}

const runsOf = (job: Job): string[] => job.steps.flatMap((step) => step.run ?? []);
const allSteps = (): Step[] => Object.values(workflow.jobs).flatMap((job) => job.steps);

function stepRunning(job: Job, fragment: string): Step {
  const found = job.steps.filter((step) => step.run?.includes(fragment));
  expect(found, `exactly one step that runs "${fragment}"`).toHaveLength(1);
  return found[0] as Step;
}

describe("ci.yml: the frame", () => {
  it("runs on a push to main and on every pull request", () => {
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.pull_request).toBeNull();
  });

  it("cancels the superseded run of the same ref", () => {
    expect(workflow.concurrency.group).toContain("${{ github.ref }}");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
  });

  it("grants the token read access to the contents and nothing else, in no job more", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflowText).not.toMatch(/^\s*permissions:\s*write-all/m);
    // jobSchema is strict and has no `permissions` key: no job widens the grant.
  });

  it("has exactly the five jobs", () => {
    expect(Object.keys(workflow.jobs)).toEqual([
      "static",
      "unit",
      "e2e",
      "self-isolation",
      "sonar",
    ]);
  });

  it("never lets a failing step pass", () => {
    expect(workflowText).not.toContain("continue-on-error");
    for (const run of allSteps().flatMap((step) => step.run ?? [])) {
      expect(run).not.toMatch(/\|\|\s*true\b/);
    }
  });

  it("pins every action to a full commit SHA, with the release in a comment", () => {
    const uses = allSteps().flatMap((step) => step.uses ?? []);
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) {
      expect(reference).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
    }
    const lines = workflowText.split("\n").filter((line) => /^\s*uses:/.test(line));
    expect(lines).toHaveLength(uses.length);
    for (const line of lines) {
      expect(line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
    // One commit per action: two pins of the same action may not drift apart.
    const byAction = new Map<string, Set<string>>();
    for (const reference of uses) {
      const [action = "", sha = ""] = reference.split("@");
      byAction.set(action, (byAction.get(action) ?? new Set()).add(sha));
    }
    for (const [action, shas] of byAction) {
      expect([...shas], `${action} is pinned to one commit`).toHaveLength(1);
    }
  });

  it("checks out without leaving the token in the git config", () => {
    const checkouts = allSteps().filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(Object.keys(workflow.jobs).length);
    for (const checkout of checkouts) {
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("installs with npm ci on a Node that package.json accepts, with the npm cache", () => {
    const engines = z
      .object({ engines: z.object({ node: z.string() }) })
      .parse(JSON.parse(read("package.json"))).engines.node;
    expect(engines).toBe(">=22.22.2");
    // Any 24.x is newer than 22.22.2; ADR 0001 allows the 22.x and 24.x LTS lines.
    expect(workflow.env.NODE_VERSION).toBe("24");
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const setup = job.steps.filter((step) => step.uses?.startsWith("actions/setup-node@"));
      expect(setup, `${id} sets up Node once`).toHaveLength(1);
      expect(setup[0]?.with).toEqual({ "node-version": "${{ env.NODE_VERSION }}", cache: "npm" });
      expect(runsOf(job).filter((run) => run === "npm ci")).toHaveLength(1);
    }
    expect(workflowText).not.toMatch(/npm (install|i)\b/);
  });

  it("keeps expressions out of the shell: no ${{ }} inside a run block", () => {
    for (const run of allSteps().flatMap((step) => step.run ?? [])) {
      expect(run).not.toContain("${{");
    }
  });
});

describe("ci.yml: static", () => {
  it("runs lint, type-check, rules check and format check as steps of their own", () => {
    expect(runsOf(jobOf("static"))).toEqual([
      "npm ci",
      "npm run lint",
      "npm run typecheck",
      "npm run rules",
      "npm run format:check",
    ]);
  });

  it("runs the scripts that package.json really has", () => {
    const scripts = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(read("package.json"))).scripts;
    const called = allSteps()
      .flatMap((step) => step.run ?? [])
      .flatMap((run) => [...run.matchAll(/npm run ([\w:-]+)/g)].map((match) => match[1] ?? ""));
    expect(called.length).toBeGreaterThan(0);
    for (const script of called) {
      expect(Object.keys(scripts)).toContain(script);
    }
  });
});

describe("ci.yml: unit", () => {
  const unit = jobOf("unit");

  it("has a Redis service container with a health check, on the loopback port", () => {
    const redis = unit.services?.redis;
    expect(redis?.image).toBe("redis:7-alpine");
    expect(redis?.ports).toEqual(["6379:6379"]);
    expect(redis?.options).toContain("--health-cmd");
    // The same image as the local compose file.
    expect(read("docker-compose.yml")).toContain("image: redis:7-alpine");
  });

  it("gives the tests a loopback REDIS_URL, the only kind the network guard lets through", () => {
    expect(unit.env?.REDIS_URL).toBe("redis://127.0.0.1:6379");
  });

  it("runs the tests with coverage and uploads the LCOV report", () => {
    expect(runsOf(unit)).toEqual(["npm ci", "npm run test:coverage"]);
    const upload = unit.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.with).toMatchObject({
      name: "coverage-lcov",
      path: "coverage/lcov.info",
      "if-no-files-found": "error",
    });
    expect(upload?.if).toBeUndefined();
  });
});

describe("ci.yml: e2e", () => {
  const e2e = jobOf("e2e");

  it("installs Chromium with its system libraries, builds and runs Playwright", () => {
    expect(runsOf(e2e)).toEqual([
      "npm ci",
      "npx playwright install --with-deps chromium",
      "npm run e2e",
    ]);
  });

  it("uploads the Playwright report only when the job failed", () => {
    const upload = e2e.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.if).toBe("${{ failure() }}");
    expect(String(upload?.with?.path)).toContain("playwright-report/");
  });
});

describe("ci.yml: self-isolation", () => {
  const job = jobOf("self-isolation");

  it("has a Postgres 18 service container, the image the exported workflow names", () => {
    const postgres = job.services?.postgres;
    expect(postgres?.image).toBe(POSTGRES_IMAGE);
    expect(postgres?.image).toMatch(/^postgres:18(-|$)/);
    expect(postgres?.ports).toEqual(["5432:5432"]);
    expect(postgres?.options).toContain("--health-cmd");
    expect(job.env).toMatchObject({
      PGHOST: "127.0.0.1",
      PGPORT: "5432",
      PGUSER: "postgres",
      PGDATABASE: "postgres",
      PGTZ: "UTC",
    });
    // The password of a throwaway container, not a secret; and nothing here reads one.
    expect(job.env?.PGPASSWORD).toBe(postgres?.env?.POSTGRES_PASSWORD);
    expect(JSON.stringify(job)).not.toContain("secrets.");
  });

  it("generates the proof with the repository's script", () => {
    const generate = stepRunning(job, "scripts/self-isolation/generate.ts");
    expect(generate.run).toBe(
      'npx tsx scripts/self-isolation/generate.ts "$RUNNER_TEMP/self-isolation"',
    );
  });

  it("loads setup, supabase/migrations and seed in ONE psql session that stops on an error", () => {
    const load = stepRunning(job, "supabase/migrations/*.sql");
    const run = load.run ?? "";
    expect(run.match(/\bpsql\b/g)).toHaveLength(1);
    expect(run).toContain("psql --no-psqlrc -v ON_ERROR_STOP=1");
    const order = [
      "rls-isolation.setup.sql",
      "supabase/migrations/*.sql",
      "rls-isolation.seed.sql",
      "psql --no-psqlrc",
    ].map((fragment) => run.indexOf(fragment));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The glob is sorted by the C locale, on every runner.
    expect(job.env?.LC_ALL).toBe("C");
  });

  it("ends with the exported test file; its exit status is the job's", () => {
    const last = job.steps.at(-1);
    expect(last?.run).toBe(
      'psql --no-psqlrc -v ON_ERROR_STOP=1 --file "$RUNNER_TEMP/self-isolation/rls-isolation.test.sql"',
    );
    expect(last?.if).toBeUndefined();
    for (const step of job.steps) {
      expect(step.if, `${step.name} is unconditional`).toBeUndefined();
    }
  });
});

describe("ci.yml: sonar", () => {
  const sonar = jobOf("sonar");
  const [probe, ...rest] = sonar.steps;
  const hasToken = "${{ steps.sonar.outputs.has_token == 'true' }}";

  it("needs the unit job, whose artifact it scans with", () => {
    expect(sonar.needs).toBe("unit");
    const download = sonar.steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    expect(download?.with).toEqual({ name: "coverage-lcov", path: "coverage" });
  });

  it("reads no secret in a job-level if: that context does not exist there", () => {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(job.if ?? "", `jobs.${id}.if`).not.toContain("secrets.");
    }
    expect(sonar.if).toBeUndefined();
  });

  it("starts with a step that publishes only whether the token is set", () => {
    expect(probe?.id).toBe("sonar");
    expect(probe?.if).toBeUndefined();
    expect(probe?.env).toEqual({ SONAR_TOKEN: "${{ secrets.SONAR_TOKEN }}" });
    expect(probe?.run).toContain('echo "has_token=true" >>"$GITHUB_OUTPUT"');
    expect(probe?.run).toContain('echo "has_token=false" >>"$GITHUB_OUTPUT"');
    // The value itself is never printed or written anywhere.
    expect(probe?.run?.match(/\$\{?SONAR_TOKEN/g)).toHaveLength(1);
    expect(probe?.run).toContain('[ -n "$SONAR_TOKEN" ]');
  });

  it("skips every other step cleanly when the token is absent", () => {
    expect(rest.length).toBeGreaterThan(0);
    for (const step of rest) {
      expect(step.if, step.name).toBe(hasToken);
    }
  });

  it("checks out the full history for the scan", () => {
    const checkout = sonar.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  it("scans with @sonar/scan, waits for the quality gate and takes the server from secrets", () => {
    const scan = stepRunning(sonar, "npx --no-install sonar-scanner-npm");
    expect(scan).toBe(sonar.steps.at(-1));
    expect(scan.env).toEqual({
      SONAR_TOKEN: "${{ secrets.SONAR_TOKEN }}",
      SONAR_HOST_URL: "${{ secrets.SONAR_HOST_URL }}",
      CI_SONAR_ORGANIZATION: "${{ vars.SONAR_ORGANIZATION }}",
      CI_SONAR_PROJECT_KEY: "${{ vars.SONAR_PROJECT_KEY }}",
    });
    expect(scan.run).toContain("-Dsonar.qualitygate.wait=true");
    expect(scan.run).toContain('"-Dsonar.organization=$CI_SONAR_ORGANIZATION"');
    // The scanner's binary name is the installed package's, not a remembered one.
    const scanner = z
      .object({ bin: z.record(z.string(), z.string()) })
      .parse(JSON.parse(read("node_modules/@sonar/scan/package.json")));
    expect(Object.keys(scanner.bin)).toContain("sonar-scanner-npm");
  });

  it("maps secrets into step environments only", () => {
    const withSecrets = allSteps().filter((step) => JSON.stringify(step).includes("secrets."));
    expect(withSecrets.map((step) => step.name)).toEqual([probe?.name, sonar.steps.at(-1)?.name]);
    for (const step of withSecrets) {
      const outsideEnv = { ...step, env: undefined };
      expect(JSON.stringify(outsideEnv)).not.toContain("secrets.");
    }
    expect(JSON.stringify(workflow.env)).not.toContain("secrets.");
  });
});

describe("dependabot.yml", () => {
  const scheduleSchema = z.strictObject({
    interval: z.literal("weekly"),
    day: z.string(),
    time: z.string(),
    timezone: z.string(),
  });
  const updateSchema = z.strictObject({
    "package-ecosystem": z.string(),
    directory: z.literal("/"),
    schedule: scheduleSchema,
    "open-pull-requests-limit": z.number().int().min(1).max(10),
    "commit-message": z.strictObject({ prefix: z.string(), include: z.literal("scope") }),
    groups: z.record(
      z.string(),
      z.strictObject({
        "update-types": z.array(z.enum(["major", "minor", "patch"])).optional(),
        patterns: z.array(z.string()).optional(),
      }),
    ),
  });
  const dependabot = z
    .strictObject({ version: z.literal(2), updates: z.array(updateSchema) })
    .parse(parse(read(".github/dependabot.yml")));

  it("watches npm and the GitHub Actions, weekly", () => {
    expect(dependabot.updates.map((update) => update["package-ecosystem"])).toEqual([
      "npm",
      "github-actions",
    ]);
  });

  it("groups npm minor and patch updates; a major update stays on its own", () => {
    const npm = dependabot.updates[0];
    expect(Object.values(npm?.groups ?? {})).toEqual([{ "update-types": ["minor", "patch"] }]);
  });

  it("writes subjects that the commit-msg hook accepts", () => {
    const subject = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)$/;
    for (const update of dependabot.updates) {
      expect(update["commit-message"].prefix).toMatch(subject);
    }
  });
});
