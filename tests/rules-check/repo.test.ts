/**
 * The one process the rules check starts is git, and it starts it by an absolute path that never
 * lies inside the repository: `npm run` puts node_modules/.bin first on PATH, so a package that
 * ships a bin called "git" would otherwise answer "which files are tracked".
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGitInfo, findGit, gitTrackedAmong } from "../../scripts/rules-check/repo.mjs";

let sandbox: string;
let root: string;
let plantedBin: string;
let systemBin: string;

/** A stand-in for git: it ignores its arguments and lists `output` the way `ls-files -z` does. */
function writeGit(dir: string, output: string, mode = 0o755): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "git");
  writeFileSync(file, `#!/bin/sh\nprintf '${output}\\0'\n`);
  chmodSync(file, mode);
  return file;
}

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), "rules-check-git-")));
  root = path.join(sandbox, "repo");
  plantedBin = path.join(root, "node_modules", ".bin");
  systemBin = path.join(sandbox, "usr", "bin");
  writeGit(plantedBin, "planted.txt");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe("findGit", () => {
  it("never takes a git from inside the repository, however early it is on PATH", () => {
    const system = writeGit(systemBin, "tracked.txt");

    expect(findGit(root, [plantedBin, root, systemBin].join(path.delimiter))).toBe(system);
    expect(findGit(root, plantedBin)).toBeNull();
  });

  it("skips relative PATH entries, which mean whatever the current directory is", () => {
    const system = writeGit(systemBin, "tracked.txt");
    const relative = path.relative(process.cwd(), systemBin);

    expect(findGit(root, [".", relative].join(path.delimiter))).toBeNull();
    expect(findGit(root, [".", "", relative, systemBin].join(path.delimiter))).toBe(system);
  });

  it("skips entries that do not exist and a git that cannot be executed", () => {
    const missing = path.join(sandbox, "missing");
    writeGit(systemBin, "tracked.txt", 0o644);
    mkdirSync(path.join(sandbox, "opt", "git"), { recursive: true });

    const searchPath = [missing, systemBin, path.join(sandbox, "opt")].join(path.delimiter);
    expect(findGit(root, searchPath)).toBeNull();
  });
});

describe("createGitInfo", () => {
  it("asks the git outside the repository, not the one a package planted", () => {
    writeGit(systemBin, "tracked.txt");
    vi.stubEnv("PATH", [plantedBin, systemBin].join(path.delimiter));

    const git = createGitInfo(root);
    expect(git.tracked()).toEqual(["tracked.txt"]);
    expect(git.unignored()).toEqual(["tracked.txt"]);
    expect(gitTrackedAmong(root, [".env.local"])).toEqual(["tracked.txt"]);
    expect(gitTrackedAmong(root, [])).toEqual([]);
  });

  it("answers null when git fails, as it does outside a work tree", () => {
    mkdirSync(systemBin, { recursive: true });
    writeFileSync(path.join(systemBin, "git"), "#!/bin/sh\nexit 128\n", { mode: 0o755 });
    vi.stubEnv("PATH", systemBin);

    expect(createGitInfo(root).tracked()).toBeNull();
  });

  it("answers null, as for a directory without git, when PATH offers only the planted one", () => {
    vi.stubEnv("PATH", plantedBin);

    expect(createGitInfo(root).tracked()).toBeNull();
    expect(gitTrackedAmong(root, [".env.local"])).toEqual([]);
  });
});
