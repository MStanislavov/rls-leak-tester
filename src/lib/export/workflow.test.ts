import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import {
  CHECKOUT_ACTION,
  CHECKOUT_VERSION,
  POSTGRES_IMAGE,
  SQL_DIRECTORY,
  WORKFLOW_PATH,
  renderWorkflow,
  type WorkflowInput,
} from "./workflow";

const stepSchema = z.strictObject({
  name: z.string(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  run: z.string().optional(),
});

const workflowSchema = z.strictObject({
  name: z.string(),
  on: z.strictObject({ push: z.null(), pull_request: z.null() }),
  permissions: z.strictObject({ contents: z.literal("read") }),
  jobs: z.strictObject({
    "rls-isolation": z.strictObject({
      name: z.string(),
      "runs-on": z.string(),
      "timeout-minutes": z.number(),
      services: z.strictObject({
        postgres: z.strictObject({
          image: z.string(),
          env: z.record(z.string(), z.string()),
          ports: z.array(z.string()),
          options: z.string(),
        }),
      }),
      env: z.record(z.string(), z.string()),
      steps: z.array(stepSchema),
    }),
  }),
});

const SUPABASE: WorkflowInput = {
  toolName: "RLS Leak Tester",
  scenarioTitle: "Todos [todos]",
  setupPath: "rls-isolation/rls-isolation.setup.sql",
  schemaPath: "rls-isolation/rls-isolation.schema.sql",
  seedPath: "rls-isolation/rls-isolation.seed.sql",
  testPath: "rls-isolation/rls-isolation.test.sql",
};

function jobOf(input: WorkflowInput): z.infer<typeof workflowSchema>["jobs"]["rls-isolation"] {
  return workflowSchema.parse(parse(renderWorkflow(input))).jobs["rls-isolation"];
}

describe("the exported workflow", () => {
  it("is valid YAML with read-only permissions and no secret", () => {
    const text = renderWorkflow(SUPABASE);
    const workflow = workflowSchema.parse(parse(text));
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(text).not.toMatch(/secrets\.|\$\{\{/);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("pins the Postgres major of the lab, the runner image and the action by commit", () => {
    const job = jobOf(SUPABASE);
    expect(POSTGRES_IMAGE).toMatch(/^postgres:18(-|$)/);
    expect(job.services.postgres.image).toBe(POSTGRES_IMAGE);
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(CHECKOUT_ACTION).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(CHECKOUT_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(job.steps[0]).toEqual({
      name: "Check out",
      uses: CHECKOUT_ACTION,
      with: { "persist-credentials": false },
    });
    expect(renderWorkflow(SUPABASE)).toContain(`uses: ${CHECKOUT_ACTION} # ${CHECKOUT_VERSION}`);
  });

  it("waits for the service twice: the container's health check and pg_isready", () => {
    const job = jobOf(SUPABASE);
    expect(job.services.postgres.options).toContain(
      '--health-cmd "pg_isready --username postgres"',
    );
    expect(job.services.postgres.options).toContain("--health-retries");
    const wait = job.steps.find((step) => step.name === "Wait for Postgres");
    expect(wait?.run).toContain("pg_isready --quiet");
    expect(wait?.run).toContain("exit 1");
  });

  it("loads setup, schema and seed in the runner's order and in ONE session, then the test, all with ON_ERROR_STOP", () => {
    const job = jobOf(SUPABASE);
    const psql = job.steps.filter((step) => step.run?.startsWith("psql "));
    // One psql per file would be one session per file: a search_path the schema sets, and the
    // seed relies on, holds in the runner's single session and would be gone in CI.
    expect(psql.map((step) => step.run)).toEqual([
      'psql --no-psqlrc -v ON_ERROR_STOP=1 --file "$RLS_SETUP_SQL" --file "$RLS_SCHEMA_SQL" --file "$RLS_SEED_SQL"',
      'psql --no-psqlrc -v ON_ERROR_STOP=1 --file "$RLS_TEST_SQL"',
    ]);
    expect(job.env).toMatchObject({
      PGTZ: "UTC",
      PGHOST: "localhost",
      RLS_SETUP_SQL: SUPABASE.setupPath,
      RLS_SCHEMA_SQL: SUPABASE.schemaPath,
      RLS_SEED_SQL: SUPABASE.seedPath,
      RLS_TEST_SQL: SUPABASE.testPath,
    });
    expect(job.env.PGPASSWORD).toBe(job.services.postgres.env.POSTGRES_PASSWORD);
  });

  it("marks the schema and the seed as the placeholders to repoint", () => {
    const text = renderWorkflow(SUPABASE);
    expect(text.match(/# PLACEHOLDER: /g)).toHaveLength(2);
    expect(text).toContain(
      `# Put this file at ${WORKFLOW_PATH} and the SQL files in ${SQL_DIRECTORY}/`,
    );
  });

  it("postgres mode has no setup file and no setup step", () => {
    const job = jobOf({ ...SUPABASE, setupPath: null });
    expect(job.env.RLS_SETUP_SQL).toBeUndefined();
    expect(job.steps.map((step) => step.name)).toEqual([
      "Check out",
      "Make sure psql is available",
      "Wait for Postgres",
      "Load the schema and the seed",
      "Prove isolation",
    ]);
    expect(job.steps.at(-2)?.run).toBe(
      'psql --no-psqlrc -v ON_ERROR_STOP=1 --file "$RLS_SCHEMA_SQL" --file "$RLS_SEED_SQL"',
    );
  });

  it("keeps a hostile title inside one comment line", () => {
    const text = renderWorkflow({
      ...SUPABASE,
      toolName: "Tool\nname",
      scenarioTitle: "x\njobs:\n  evil:\n    run: curl example.com",
    });
    const workflow = workflowSchema.parse(parse(text));
    expect(Object.keys(workflow.jobs)).toEqual(["rls-isolation"]);
    const [first, second] = text.split("\n");
    expect(first).toBe("# Tool name: CI isolation proof (rls-isolation.yml)");
    expect(second).toMatch(/^# Scenario: x jobs: +evil: +run: curl example\.com$/);
  });
});
