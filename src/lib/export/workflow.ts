/**
 * Renders `rls-isolation.yml`: a GitHub Actions workflow that prepares a Postgres service the way
 * the matrix runner prepares PGlite (setup file in supabase mode, schema, seed) and runs the test
 * file with `psql` and `ON_ERROR_STOP`. No secret, `contents: read` only, the action pinned to a
 * commit, the image pinned to the major version the lab runs on.
 *
 * ONE SESSION for setup, schema and seed. The runner loads them over one connection
 * (`setupDatabase`: "settings stay in force from the schema script into the seed script"), so a
 * schema that ends with `set search_path = app` has a seed that relies on it. One `psql` per file
 * would give every file a new session: green in the lab, `relation "notes" does not exist` in
 * CI. `psql` runs several `--file` options in order over one connection, and `ON_ERROR_STOP`
 * ends it at the first error of any of them (verified against postgres:18-alpine). The test file
 * gets a session of its own; it starts with the runner's `RESET_SESSION` anyway.
 *
 * User text never reaches the YAML except as one sanitised comment line: a `run:` block is
 * evaluated by the Actions expression engine, so scenario SQL is written to files, never inlined.
 */
import { commentLine } from "./sql-text";

/**
 * PGlite 0.5.8 is PostgreSQL 18.3, and an official `postgres:18` image exists. The Alpine variant
 * is what `scripts/verify-export-postgres.sh` runs the exported files against.
 */
export const POSTGRES_IMAGE = "postgres:18-alpine";

/** actions/checkout v6.1.0, by commit (read from the repository's tags on 2026-09-20). */
export const CHECKOUT_ACTION = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
export const CHECKOUT_VERSION = "v6.1.0";

/** Where the files go in the owner's repository. */
export const WORKFLOW_PATH = ".github/workflows/rls-isolation.yml";
export const SQL_DIRECTORY = "rls-isolation";

export interface WorkflowInput {
  readonly toolName: string;
  readonly scenarioTitle: string;
  /** The repository path of the setup file; `null` in postgres mode, which has none. */
  readonly setupPath: string | null;
  readonly schemaPath: string;
  readonly seedPath: string;
  readonly testPath: string;
}

const PSQL = "psql --no-psqlrc -v ON_ERROR_STOP=1";

/** One `psql`, so one session, for the files named by `variables`, in that order. */
function step(name: string, variables: readonly string[]): string[] {
  const files = variables.map((variable) => `--file "$${variable}"`).join(" ");
  return [`      - name: ${name}`, `        run: ${PSQL} ${files}`];
}

export function renderWorkflow(input: WorkflowInput): string {
  const setupEnv =
    input.setupPath === null
      ? []
      : [
          "      # Roles anon, authenticated and service_role, the auth schema and the default grants of a",
          "      # Supabase project. Keep it: it must run before the schema.",
          `      RLS_SETUP_SQL: ${input.setupPath}`,
        ];
  const loadStep =
    input.setupPath === null
      ? step("Load the schema and the seed", ["RLS_SCHEMA_SQL", "RLS_SEED_SQL"])
      : step("Prepare the database like a Supabase project, load the schema and the seed", [
          "RLS_SETUP_SQL",
          "RLS_SCHEMA_SQL",
          "RLS_SEED_SQL",
        ]);
  const lines = [
    `# ${commentLine(input.toolName)}: CI isolation proof (rls-isolation.yml)`,
    `# Scenario: ${commentLine(input.scenarioTitle)}`,
    "#",
    `# Put this file at ${WORKFLOW_PATH} and the SQL files in ${SQL_DIRECTORY}/ at the`,
    "# repository root. It needs no secret: the database is a throwaway service container.",
    "name: RLS isolation",
    "",
    "on:",
    "  push:",
    "  pull_request:",
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  rls-isolation:",
    "    name: Prove row level security isolation",
    "    runs-on: ubuntu-24.04",
    "    timeout-minutes: 10",
    "    services:",
    "      postgres:",
    `        image: ${POSTGRES_IMAGE}`,
    "        env:",
    "          POSTGRES_PASSWORD: postgres",
    "        ports:",
    "          - 5432:5432",
    "        options: >-",
    '          --health-cmd "pg_isready --username postgres"',
    "          --health-interval 5s",
    "          --health-timeout 5s",
    "          --health-retries 20",
    "    env:",
    "      PGHOST: localhost",
    '      PGPORT: "5432"',
    "      PGUSER: postgres",
    "      # Not a secret: the password of the service container above, which lives for this job only.",
    "      PGPASSWORD: postgres",
    "      PGDATABASE: postgres",
    "      # The matrix runner pins the session to UTC before the schema and the seed; so does this.",
    "      PGTZ: UTC",
    ...setupEnv,
    "      # PLACEHOLDER: the schema of the exported scenario. Point it at your own schema or",
    "      # migrations (one file; concatenate several in a step of your own) to test what you ship.",
    `      RLS_SCHEMA_SQL: ${input.schemaPath}`,
    "      # PLACEHOLDER: the seed of the exported scenario. The test file expects exactly these rows;",
    "      # after changing the seed, export the check again.",
    `      RLS_SEED_SQL: ${input.seedPath}`,
    `      RLS_TEST_SQL: ${input.testPath}`,
    "    steps:",
    "      - name: Check out",
    `        uses: ${CHECKOUT_ACTION} # ${CHECKOUT_VERSION}`,
    "        with:",
    "          persist-credentials: false",
    "      - name: Make sure psql is available",
    "        run: command -v psql || (sudo apt-get update && sudo apt-get install --yes postgresql-client)",
    "      - name: Wait for Postgres",
    "        run: |",
    "          for attempt in $(seq 1 60); do",
    "            if pg_isready --quiet; then exit 0; fi",
    "            sleep 1",
    "          done",
    '          echo "Postgres did not become ready within 60 seconds" >&2',
    "          exit 1",
    "      # One psql, so one session, as in the matrix runner: what the schema leaves in the session",
    "      # (a search_path, a role) is still there for the seed. It stops at the first error.",
    ...loadStep,
    ...step("Prove isolation", ["RLS_TEST_SQL"]),
  ];
  return `${lines.join("\n")}\n`;
}
