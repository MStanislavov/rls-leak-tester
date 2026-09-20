#!/usr/bin/env node
/**
 * `npm run quality`: the single local gate (brief 5.2). The stages run in a fixed order and the
 * run stops at the first one that fails, saying which one it was and how to run it alone:
 *
 *   sonar preflight, format, lint, typecheck, rules, unit tests with coverage, build,
 *   end to end (production mode), Sonar scan with quality gate wait
 *
 * The Sonar stage is never skipped silently. Without a reachable server or without .env.sonar
 * the run FAILS (in the preflight, before anything slow starts) and prints the commands that
 * start and bootstrap the server. `--no-sonar` exists for a machine without Docker: every other
 * stage still has to pass, and the last line says that the gate was NOT fully run.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {object} Stage
 * @property {string} id
 * @property {string} title
 * @property {readonly string[]} command the program and its arguments, no shell
 * @property {string} rerun how to run this stage alone
 * @property {string} [hint] what to do when it fails, beyond re-running it
 * @property {() => Promise<{ env?: Record<string, string>, notes?: string[] }>} [before]
 *   runs right before the command; may add environment variables and lines to print
 */
/** @typedef {{ id: string, code: number, ms: number }} StageResult */
/**
 * @typedef {object} RunResult
 * @property {boolean} ok
 * @property {StageResult[]} results one entry per stage that was started
 * @property {{ index: number, stage: Stage, code: number } | null} failed
 * @property {number} total
 */
/**
 * @typedef {object} Io
 * @property {(line: string) => void} log
 * @property {(command: readonly string[], env: Record<string, string>) => Promise<number>} exec
 * @property {() => number} now
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REDIS_URL = "redis://127.0.0.1:6379";
export const SONAR_SETUP = [
  "docker compose up -d --wait sonarqube   # first start takes 2 to 4 minutes",
  "npm run sonar:bootstrap                 # rotates the admin password, writes .env.sonar",
];

/**
 * Runs a command without a shell. Resolves with its exit code: 127 when it cannot be started,
 * 1 when a signal ended it.
 * @param {readonly string[]} command
 * @param {Record<string, string>} env added to the environment of this process
 * @param {"inherit" | "ignore"} [stdio]
 * @returns {Promise<number>}
 */
export function execCommand(command, env, stdio = "inherit") {
  return new Promise((resolve) => {
    const [program = "", ...args] = command;
    const child = spawn(program, args, {
      cwd: REPO_ROOT,
      stdio,
      env: { ...process.env, ...env },
    });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** @type {Io} */
const REAL_IO = {
  log: (line) => console.log(line),
  exec: (command, env) => execCommand(command, env),
  now: () => Date.now(),
};

/**
 * Brings Redis up when Docker is there, so that the adapter contract suite also runs on a real
 * Redis. Without Docker the suite runs on the in-memory adapter only, and the run says so.
 * @param {(program: string, args: string[]) => number} [probe] exit code of a quiet command
 * @param {Record<string, string | undefined>} [env] where a REDIS_URL the caller has is found
 * @returns {Promise<{ env?: Record<string, string>, notes: string[] }>}
 */
export async function provideRedis(probe = quietExitCode, env = process.env) {
  if ((env.REDIS_URL ?? "").trim() !== "") {
    return { notes: ["REDIS_URL is already set: the Redis contract suite uses that server."] };
  }
  if (probe("docker", ["info"]) !== 0) {
    return {
      notes: [
        "Docker is not available: the Redis contract suite runs on the in-memory adapter only",
        "(hermetic run). With Docker, this stage starts redis and sets REDIS_URL itself.",
      ],
    };
  }
  if (probe("docker", ["compose", "up", "-d", "--wait", "redis"]) !== 0) {
    throw new Error("`docker compose up -d --wait redis` failed: see `docker compose logs redis`");
  }
  return {
    env: { REDIS_URL },
    notes: [`redis is up (docker compose): REDIS_URL=${REDIS_URL}, the contract suite runs on it.`],
  };
}

/**
 * @param {string} program
 * @param {string[]} args
 * @returns {number}
 */
function quietExitCode(program, args) {
  const result = spawnSync(program, args, { cwd: REPO_ROOT, stdio: "ignore" });
  return result.error === undefined ? (result.status ?? 1) : 127;
}

/**
 * The stages of the gate, in order.
 * @param {{ sonar: boolean }} options
 * @returns {Stage[]}
 */
export function buildStages({ sonar }) {
  const sonarHint = `Start and bootstrap the local server, then run the gate again:\n  ${SONAR_SETUP.join("\n  ")}`;
  /** @type {Stage[]} */
  const stages = [
    {
      id: "format",
      title: "format check (Prettier)",
      command: ["npm", "run", "format:check"],
      rerun: "npm run format:check   (fix with: npm run format)",
    },
    { id: "lint", title: "lint (ESLint)", command: ["npm", "run", "lint"], rerun: "npm run lint" },
    {
      id: "typecheck",
      title: "type check (tsc)",
      command: ["npm", "run", "typecheck"],
      rerun: "npm run typecheck",
    },
    {
      id: "rules",
      title: "rules check (rules.yaml)",
      command: ["npm", "run", "rules"],
      rerun: "npm run rules",
    },
    {
      id: "unit",
      title: "unit and integration tests with coverage (Vitest)",
      command: ["npm", "run", "test:coverage"],
      rerun: `REDIS_URL=${REDIS_URL} npm run test:coverage`,
      before: () => provideRedis(),
    },
    {
      id: "build",
      title: "production build (next build)",
      command: ["npm", "run", "build"],
      rerun: "npm run build",
    },
    {
      id: "e2e",
      title: "end to end, production mode (Playwright against next start)",
      command: ["npx", "--no-install", "playwright", "test"],
      rerun: "npm run e2e   (builds first; after a build: npx playwright test)",
    },
  ];
  if (!sonar) return stages;
  return [
    {
      id: "sonar-preflight",
      title: "Sonar preflight (server UP, .env.sonar present)",
      command: ["bash", "scripts/sonar/check.sh"],
      rerun: "bash scripts/sonar/check.sh",
      hint: sonarHint,
    },
    ...stages,
    {
      id: "sonar",
      title: "Sonar scan with quality gate wait",
      command: ["npm", "run", "sonar"],
      rerun: "npm run sonar   (needs coverage/lcov.info from npm run test:coverage)",
      hint: "A failed gate is read with: scripts/sonar/api.sh 'api/qualitygates/project_status?projectKey=postgres-rls-leak-tester'",
    },
  ];
}

/**
 * Runs the stages in order and stops at the first failure.
 * @param {readonly Stage[]} stages
 * @param {Io} [io]
 * @returns {Promise<RunResult>}
 */
export async function runStages(stages, io = REAL_IO) {
  /** @type {StageResult[]} */
  const results = [];
  const total = stages.length;
  for (const [index, stage] of stages.entries()) {
    io.log("");
    io.log(`=== quality ${index + 1}/${total}: ${stage.title} ===`);
    const started = io.now();
    let code;
    try {
      const prepared = (await stage.before?.()) ?? {};
      for (const note of prepared.notes ?? []) io.log(`    ${note}`);
      io.log(`    $ ${stage.command.join(" ")}`);
      code = await io.exec(stage.command, prepared.env ?? {});
    } catch (error) {
      io.log(`    ${error instanceof Error ? error.message : String(error)}`);
      code = 1;
    }
    results.push({ id: stage.id, code, ms: io.now() - started });
    if (code !== 0) return { ok: false, results, failed: { index, stage, code }, total };
  }
  return { ok: true, results, failed: null, total };
}

/**
 * The closing lines and the exit code of the process.
 * @param {RunResult} result
 * @param {{ sonar: boolean }} options
 * @returns {{ lines: string[], exitCode: number }}
 */
export function summarize(result, { sonar }) {
  const lines = [""];
  for (const entry of result.results) {
    const seconds = (entry.ms / 1000).toFixed(1).padStart(7);
    lines.push(`  ${entry.code === 0 ? "ok    " : "FAILED"} ${entry.id.padEnd(16)} ${seconds}s`);
  }
  if (result.failed !== null) {
    const { index, stage, code } = result.failed;
    const notRun = result.total - index - 1;
    lines.push(
      "",
      `quality: FAILED at stage ${index + 1}/${result.total} "${stage.id}": ${stage.title} (exit code ${code}).`,
      `quality: ${notRun} later stage${notRun === 1 ? " was" : "s were"} not run.`,
      `quality: run this stage alone with: ${stage.rerun}`,
    );
    if (stage.hint !== undefined) lines.push(`quality: ${stage.hint}`);
    return { lines, exitCode: 1 };
  }
  if (!sonar) {
    lines.push(
      "",
      `quality: all ${result.total} stages that ran passed, but the gate was NOT fully run: the Sonar scan and its quality gate were left out (--no-sonar). This is not a pass of the quality gate.`,
    );
    return { lines, exitCode: 0 };
  }
  lines.push("", `quality: PASSED, all ${result.total} stages, Sonar quality gate included.`);
  return { lines, exitCode: 0 };
}

/**
 * @param {readonly string[]} argv
 * @returns {{ sonar: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const options = { sonar: true, help: false };
  for (const arg of argv) {
    if (arg === "--no-sonar") options.sonar = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument "${arg}" (known: --no-sonar, --help)`);
  }
  return options;
}

const HELP = `npm run quality [-- --no-sonar]

Runs the whole local gate in order and stops at the first failing stage:
  ${buildStages({ sonar: true })
    .map((stage) => stage.id)
    .join(", ")}

--no-sonar  for a machine without Docker: leaves out the two Sonar stages. Every other stage
            still has to pass; the last line then says that the gate was NOT fully run.
Without the flag, a missing .env.sonar or an unreachable server fails the run and prints:
  ${SONAR_SETUP.join("\n  ")}`;

/**
 * @param {readonly string[]} argv
 * @param {{ io?: Io, stages?: (options: { sonar: boolean }) => Stage[] }} [deps]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, { io = REAL_IO, stages = buildStages } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.log(`quality: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (options.help) {
    io.log(HELP);
    return 0;
  }
  if (!options.sonar) {
    io.log("quality: --no-sonar given: the Sonar scan and its quality gate will NOT run.");
  }
  const result = await runStages(stages(options), io);
  const { lines, exitCode } = summarize(result, options);
  for (const line of lines) io.log(line);
  return exitCode;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}
