/**
 * The governance files agree with each other (rules.yaml DOD-10): .claude/settings.json is wired to
 * scripts that exist and denies what GIT-002 and SEC-003 say it denies, every rule id quoted in
 * CLAUDE.md, the reviewer agent and the hook scripts exists in rules.yaml, and every npm script
 * CLAUDE.md names exists in package.json.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { REPO_ROOT } from "./helpers";

const read = (relativePath: string) => readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; args?: string[]; timeout?: number }[];
}
interface Settings {
  permissions: { allow: string[]; deny: string[] };
  hooks: Record<string, HookEntry[]>;
}
const settings = JSON.parse(read(".claude/settings.json")) as Settings;

interface RulesFile {
  principles: { id: string }[];
  rules: { id: string }[];
  forbidden_actions: { id: string }[];
  definition_of_done: { id: string }[];
}
const rulesFile = parse(read("rules.yaml")) as RulesFile;
const knownIds = new Set(
  [
    rulesFile.principles,
    rulesFile.rules,
    rulesFile.forbidden_actions,
    rulesFile.definition_of_done,
  ].flatMap((list) => list.map((entry) => entry.id)),
);

describe(".claude/settings.json", () => {
  it.each([
    ["PreToolUse", "scripts/hooks/pre-edit.sh"],
    ["PostToolUse", "scripts/hooks/post-edit.sh"],
  ])("wires %s on the four editing tools to %s", (event, script) => {
    const entries = settings.hooks[event] ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    const hook = entries[0]?.hooks[0];
    // Exec form: no shell parses the path, and the script needs no executable bit.
    expect(hook).toMatchObject({
      type: "command",
      command: "sh",
      args: [`\${CLAUDE_PROJECT_DIR}/${script}`],
    });
    expect(hook?.timeout).toBeLessThanOrEqual(30);
    expect(existsSync(path.join(REPO_ROOT, script))).toBe(true);
  });

  it("denies what GIT-002 forbids", () => {
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        "Bash(git push *)",
        "Bash(git remote add *)",
        "Bash(git reset --hard *)",
        "Bash(git rebase *)",
        "Bash(git filter-branch *)",
        "Bash(git commit --amend *)",
        "Bash(git commit --no-verify *)",
        // -n is --no-verify. The forms without a space also stop a cluster: -nm, -anm, -an.
        "Bash(git commit -n*)",
        "Bash(git commit * -n*)",
        "Bash(git commit -an*)",
        "Bash(git commit * -an*)",
        // Forced operations (brief 6.3). A forced add is how a git-ignored env file gets staged.
        "Bash(git add -f*)",
        "Bash(git add * -f*)",
        "Bash(git add --force*)",
        "Bash(git add * --force*)",
        "Bash(git add -Af*)",
        "Bash(git add * -Af*)",
        "Bash(git tag -f*)",
        "Bash(git tag * -f*)",
        "Bash(git tag --force*)",
        "Bash(git branch -f*)",
        "Bash(git branch * -f*)",
        "Bash(git branch --force*)",
        "Bash(git checkout -f*)",
        "Bash(git switch -f*)",
        "Bash(git clean *)",
        "Bash(vercel *)",
        "Bash(npx vercel *)",
        "Bash(supabase db push *)",
        "Bash(supabase link *)",
        "Bash(supabase functions deploy *)",
        "Bash(npx supabase db push *)",
        "Bash(npx supabase link *)",
      ]),
    );
  });

  /**
   * The documented matching of a Bash rule (code.claude.com/docs/en/permissions, "Wildcard
   * patterns"): the rule is compared with the whole command, `*` stands for any text including
   * spaces, and a rule whose only `*` is a trailing ` *` also matches the bare command.
   */
  function ruleMatches(rule: string, command: string): boolean {
    const pattern = /^Bash\((.*)\)$/.exec(rule)?.[1]?.replace(/:\*$/, " *");
    if (pattern === undefined) return false;
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, "\\$&"))
      .join("[\\s\\S]*");
    if (new RegExp(`^${escaped}$`).test(command)) return true;
    return pattern.endsWith(" *") && pattern.indexOf("*") === pattern.length - 1
      ? command === pattern.slice(0, -2)
      : false;
  }
  const deniedBy = (command: string) =>
    settings.permissions.deny.filter((rule) => ruleMatches(rule, command));
  const allowedBy = (command: string) =>
    settings.permissions.allow.filter((rule) => ruleMatches(rule, command));

  it("emulates the documented rule matching", () => {
    expect(ruleMatches("Bash(ls *)", "ls -la")).toBe(true);
    expect(ruleMatches("Bash(ls *)", "ls")).toBe(true);
    expect(ruleMatches("Bash(ls *)", "lsof")).toBe(false);
    expect(ruleMatches("Bash(ls*)", "lsof")).toBe(true);
    expect(ruleMatches("Bash(git log * main)", "git log --oneline main")).toBe(true);
    expect(ruleMatches("Bash(git log * main)", "git log main")).toBe(false);
    expect(ruleMatches("Bash(* --help *)", "npm --help x")).toBe(true);
    expect(ruleMatches("Bash(* --help *)", "npm --help")).toBe(false);
    expect(ruleMatches("Bash(npm run build)", "npm run build --watch")).toBe(false);
  });

  it.each([
    // A forced add stages what .gitignore keeps out, the real env files first of all.
    "git add -f .env.local",
    "git add --force .env.local",
    "git add . -f",
    "git add . --force",
    "git add -fA",
    "git add -Af",
    "git add -A -f",
    "git add -uf",
    "git add -v -f .env",
    "git add --force",
    // -n is --no-verify: it skips lint-staged (SEC-003) and commit-msg (GIT-001).
    'git commit --no-verify -m "feat: x"',
    'git commit -m "feat: x" --no-verify',
    "git commit -n",
    'git commit -n -m "feat: x"',
    'git commit -m "feat: x" -n',
    'git commit -nm "feat: x"',
    'git commit -anm "feat: x"',
    'git commit -a -nm "feat: x"',
    'git commit -am "feat: x" -n',
    'git commit -snm "feat: x"',
    'git commit -qnm "feat: x"',
    "git commit --amend",
    "git commit --amend --no-edit",
    'git commit -m "feat: x" --amend',
    // Forced tag, branch, checkout and switch.
    "git tag -f v0.1.0",
    "git tag --force v0.1.0",
    "git tag v0.1.0 -f",
    "git tag -fa v0.1.0 -m release",
    "git tag -af v0.1.0 -m release",
    "git branch -f main HEAD~1",
    "git branch --force main HEAD~1",
    "git branch main HEAD~1 -f",
    "git branch -D feature",
    "git checkout -f",
    "git checkout -f main",
    "git checkout main -f",
    "git checkout --force main",
    "git switch -f main",
    "git switch main --force",
    "git switch --discard-changes main",
    "git clean -fd",
    "git push",
    "git push --force origin main",
    "git reset --hard HEAD~1",
    "git rebase main",
  ])("denies `%s`", (command) => {
    expect(deniedBy(command), command).not.toEqual([]);
  });

  it.each([
    "git add .",
    "git add -A",
    "git add -u",
    "git add src/lib/config/env.ts tests/hooks/governance.test.ts",
    "git add -- docs/adr/0008-second-governance-review.md",
    "git commit",
    'git commit -m "feat: add the runner"',
    'git commit -am "fix(config): read the site url"',
    'git commit -a -m "docs: update the progress log"',
    'git commit -s -m "chore: sign off"',
  ])("allows `%s` without a prompt, and no deny rule names it", (command) => {
    expect(deniedBy(command), command).toEqual([]);
    expect(allowedBy(command), command).not.toEqual([]);
  });

  it.each(["git tag v0.1.0", "git tag -a v0.1.0 -m release", "git branch feature/runner"])(
    "leaves `%s` to a prompt: neither denied nor allowed",
    (command) => {
      expect(deniedBy(command), command).toEqual([]);
      expect(allowedBy(command), command).toEqual([]);
    },
  );

  it("names every forced git operation of the deny list in the GIT-002 and QUAL-002 check texts", () => {
    const checks = new Map(
      (parse(read("rules.yaml")) as { rules: { id: string; check?: string }[] }).rules.map(
        (rule) => [rule.id, rule.check ?? ""],
      ),
    );
    for (const phrase of [
      "forced add",
      "tag -f",
      "branch -f",
      "forced checkout and switch",
      "commit --amend",
    ]) {
      expect(checks.get("GIT-002"), phrase).toContain(phrase);
    }
    expect(checks.get("QUAL-002")).toContain("-nm");
  });

  it("denies reading and editing the real env files and leaves .env.example alone (SEC-003)", () => {
    for (const name of [".env", ".env.local", ".env.sonar"]) {
      expect(settings.permissions.deny).toContain(`Read(**/${name})`);
      expect(settings.permissions.deny).toContain(`Edit(**/${name})`);
    }
    const all = [...settings.permissions.allow, ...settings.permissions.deny];
    expect(all.filter((rule) => rule.includes(".env.example"))).toEqual([]);
    // Path rules are only consulted for Read(...) and Edit(...); a Write(...) rule would be dead.
    expect(all.filter((rule) => /^(Write|MultiEdit|NotebookEdit|Glob)\(/.test(rule))).toEqual([]);
  });

  it("allows the routine commands and nothing that a deny rule names", () => {
    expect(settings.permissions.allow).toEqual(
      expect.arrayContaining([
        "Bash(npm run *)",
        "Bash(npm test *)",
        "Bash(npx vitest *)",
        "Bash(npx playwright *)",
        "Bash(npx tsc *)",
        "Bash(npx eslint *)",
        "Bash(npx prettier *)",
        "Bash(node scripts/*)",
        "Bash(docker compose *)",
        "Bash(git status *)",
        "Bash(git diff *)",
        "Bash(git log *)",
        "Bash(git show *)",
        "Bash(git add *)",
        "Bash(git commit *)",
      ]),
    );
    const denied = new Set(settings.permissions.deny);
    expect(settings.permissions.allow.filter((rule) => denied.has(rule))).toEqual([]);
    expect(settings.permissions.allow.filter((rule) => /push|vercel|supabase/.test(rule))).toEqual(
      [],
    );
  });
});

describe("rule ids and commands quoted outside rules.yaml", () => {
  const prefixes = [...new Set(rulesFile.rules.map((rule) => rule.id.split("-")[0] ?? ""))];
  const idPattern = new RegExp(
    String.raw`\b(?:(?:${prefixes.join("|")})-\d{3}|FA-\d+|DOD-\d+|P\d)\b`,
    "g",
  );

  const hookFiles = readdirSync(path.join(REPO_ROOT, "scripts/hooks")).map(
    (name) => `scripts/hooks/${name}`,
  );
  const files = [
    "CLAUDE.md",
    ".claude/agents/security-reviewer.md",
    ".claude/settings.json",
    ".husky/pre-commit",
    ".husky/commit-msg",
    ...hookFiles,
  ];

  it.each(files)("%s only quotes ids that exist in rules.yaml", (file) => {
    const quoted = [...new Set(read(file).match(idPattern) ?? [])];
    expect(quoted.filter((id) => !knownIds.has(id))).toEqual([]);
  });

  it("CLAUDE.md and the reviewer agent do quote rule ids", () => {
    expect((read("CLAUDE.md").match(idPattern) ?? []).length).toBeGreaterThan(20);
    expect(
      (read(".claude/agents/security-reviewer.md").match(idPattern) ?? []).length,
    ).toBeGreaterThan(10);
  });

  it("every npm script CLAUDE.md names exists, except the one it announces for Phase 8", () => {
    const claudeMd = read("CLAUDE.md");
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> })
      .scripts;
    const named = [...new Set([...claudeMd.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1] ?? ""))];
    expect(named).toEqual(
      expect.arrayContaining([
        "dev",
        "lint",
        "typecheck",
        "rules",
        "test:coverage",
        "e2e",
        "e2e:dev",
      ]),
    );
    const missing = named.filter((name) => !(name in scripts));
    if (missing.length > 0) {
      expect(missing).toEqual(["quality"]);
      expect(claudeMd).toMatch(/`npm run quality`[^\n]*Arrives in Phase 8/);
    }
  });

  it("CLAUDE.md and the reviewer agent describe the rules as rules.yaml has them", () => {
    // Not a copy of rules.yaml: the facts a session gets wrong when this file lags behind.
    const claudeMd = read("CLAUDE.md").replace(/\s+/g, " ");
    for (const fact of [
      "SEC-004 is an allow-list",
      '"use server"',
      "the runner takes the `SqlEngine` port as a parameter",
      "`@/lib/redis`, `@/lib/ai`, `@/lib/store`",
      "`sendBeacon`",
      "`.text()`",
      "`formData.get(`",
      "A Server Function is such a boundary too",
      "tests/setup/network-guard.setup.ts",
      "`RUN_LIVE_AI_TESTS=1`, set by whoever starts the run",
      "named only in the `rules/*` blocks",
      "`eslint --fix --max-warnings 0`",
      "forced `git add`",
    ]) {
      expect(claudeMd, fact).toContain(fact);
    }
    const reviewer = read(".claude/agents/security-reviewer.md").replace(/\s+/g, " ");
    for (const fact of ['"use server"', "A Server Function is an HTTP endpoint", "FA-4"]) {
      expect(reviewer, fact).toContain(fact);
    }
  });

  it("CLAUDE.md keeps the import of the Next.js agent rules on its first line", () => {
    expect(read("CLAUDE.md").split("\n")[0]).toBe("@AGENTS.md");
  });
});

describe(".claude/agents/security-reviewer.md", () => {
  it("has the subagent frontmatter and read-only tools only", () => {
    const text = read(".claude/agents/security-reviewer.md");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    const meta = parse(frontmatter) as { name: string; description: string; tools: string };
    expect(meta.name).toBe("security-reviewer");
    expect(meta.description.length).toBeGreaterThan(40);
    expect(meta.tools.split(",").map((tool) => tool.trim())).toEqual(["Read", "Grep", "Glob"]);
  });
});
