# ADR 0006: Claude Code settings, edit hooks, git hooks and the reviewer agent

- Status: accepted
- Date: 2026-09-19
- Phase: 2 (governance), task G3
- Versions: Claude Code 2.1.278, Husky 9.1.7, lint-staged 17.5.1, Prettier 3.9.8, ESLint 9.39.5

## Context

Sections 5.4, 6.2, 6.3 and 6.5 of the brief ask for `CLAUDE.md`, `.claude/settings.json` with
hooks that were triggered once, Husky with lint-staged, and a read-only `security-reviewer` agent.
The settings format was taken from the `update-config` skill and from the Claude Code reference
(`code.claude.com/docs/en/hooks`, `/permissions`, `/sub-agents`, read on 2026-09-19), not from
memory. Everything under "Evidence" was run on this machine.

## Decisions

### The hook contract that is used: exit code 2 and stderr

The reference says: exit 0 continues and nothing reaches the agent; exit 2 on `PreToolUse` blocks
the tool call and on `PostToolUse` "shows stderr to Claude; the tool already ran"; any other exit
code is a non-blocking error. Both scripts therefore use only 0 and 2, and write their message to
stderr. JSON output (`permissionDecision`, `decision: "block"`) would work too but adds a second
format to keep valid; exit 2 cannot be overridden by a malformed JSON.

The hooks are declared in exec form: `"command": "sh"` with the script path, which starts with
`${CLAUDE_PROJECT_DIR}`, as the only entry of `"args"`. No shell parses the project path, and the
scripts work without the executable bit, so a checkout that lost it does not silently lose its
guard (a hook that cannot start is a non-blocking error).
The matcher is the exact list `Edit|Write|MultiEdit|NotebookEdit`. `MultiEdit` is a legacy tool
name in this Claude Code version; it stays in the matcher because the brief names it and an exact
list entry that never fires costs nothing.

### `scripts/hooks/pre-edit.sh`

Blocks `.env` and every `.env.*` except `.env.example` (SEC-003, FA-3) and every file named
`package-lock.json` (brief 6.3), compared in lower case because the macOS file system
ignores case. `scripts/hooks/payload-paths.mjs` parses the payload with Node (no `jq`) and prints
`file_path`, `notebook_path`, `edits[].file_path`, the resolved path and every symbolic-link
target, including a target that does not exist yet. An unreadable payload and a path with a line
break block as well: a guard that cannot see must not wave things on.

Observed precedence: for `.env.local` the `permissions.deny` rule answers before the hook is
started (the transcript has no `hook_started` event for that call; the tool result is "File is in
a directory that is denied by your permission settings"). The hook is the layer for names the
deny list does not spell out (`.env.staging`, a symbolic link) and for the lockfile. The reference
also states that a hook that reaches its timeout does not block, which is one more reason to keep
both layers.

### `scripts/hooks/post-edit.sh`

For each existing regular file of the payload that lies inside the repository:
`prettier --write --ignore-unknown`, then `eslint --no-warn-ignored` for the extensions js, jsx,
mjs, cjs, ts, tsx, mts and cts, then `node scripts/rules-check.mjs -- <file>`. It calls the
binaries in `node_modules/.bin` directly (`npx` costs about 0.3 s per call); one TypeScript file
takes about 0.6 s in total.

- ESLint only reports; it does not run with `--fix`. The formatter already rewrites the file under
  the agent, and a second tool that rewrites code makes the agent's next `Edit` harder to predict.
  `eslint --fix` runs in lint-staged instead.
- "Not failing on unrelated files": a deleted file, a directory, a file outside the repository,
  `node_modules`, `.git`, `.next`, a missing tool and an unreadable payload end in exit 0. The
  rules check validates `rules.yaml` on every run, so a broken `rules.yaml` would be reported on
  every edit of any file; the hook drops `RULES-SCHEMA rules.yaml:` lines unless `rules.yaml` is
  the edited file. `npm run rules`, lint-staged and CI still report them.
- The report is capped at 40 lines per tool.

### Permissions

- `Read(...)` and `Edit(...)` are the only path rules Claude Code consults (`Write(path)`,
  `NotebookEdit(path)`, `MultiEdit(path)` are accepted but never matched), and a `Read` deny also
  blocks Edit and Write on that path but not NotebookEdit. So each real env file has a `Read` and an
  `Edit` deny, written as `**/<name>`. The list is `.env`, `.env.local`, `.env.sonar`,
  `.env.development`, `.env.production`, `.env.test`, `.env.*.local`. The `!` carve-out syntax
  (`Read(.env.*)` plus `Read(!.env.example)`) exists but is recent; an explicit list cannot lock
  `.env.example` by accident on an older version.
- **`git commit --amend` is denied.** Amending rewrites the last commit, the brief forbids
  rewriting history, and the workflow here is one new commit per phase; a correction is a new
  commit. **`git commit --no-verify` / `-n` is denied** too: it would skip both git hooks, which
  is weakening a gate (QUAL-002).
- Also denied beyond the brief's list: `git remote add|set-url`, `git clean`, forced
  `checkout`/`switch`, `branch -D`, `update-ref`, `reflog expire|delete`, `filter-repo`, and the
  Supabase commands that touch a remote project (`login`, `db reset --linked`, `migration repair`,
  `migration up --linked`, `functions deploy`, `secrets set`, `config push`,
  `projects create|delete`), each also through `npx`. Local Supabase commands are neither allowed
  nor denied and therefore ask.
- `git branch` is allowed only in its listing forms. `npm ci` is allowed; `npm install` asks.
- Bash rules match the command text only (`git -C . push` is not matched, as the reference says).
  They are a seat belt; GIT-002 keeps `review` as its second enforcer.

### Git hooks

- `prepare` runs `scripts/hooks/install-git-hooks.mjs` instead of bare `husky`. Husky 9 itself
  exits 0 without `.git`, but `husky` as a command does not exist after `npm ci --omit=dev`, and
  `husky || true` would hide real errors. The script skips with exit 0 when there is no `.git`,
  when `husky` cannot be imported, and when `HUSKY=0`.
- lint-staged uses two globs that cannot both match a file (`*.{js,…,cts}` and its negation
  `!(*.{js,…,cts})`), checked against lint-staged's own `matchFiles`. lint-staged runs globs
  concurrently, so with overlapping globs `prettier --write` and `eslint --fix` could write the
  same file at the same time. Every chain ends with `node scripts/rules-check.mjs --`, to which
  lint-staged appends the absolute paths.
- `.husky/commit-msg` calls `scripts/hooks/commit-msg.mjs` (no dependency). Subject is the first
  line that is neither empty nor a comment and above the scissors line; pattern
  `^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./-]+\))?!?: \S.*$`;
  subjects starting with `Merge ` pass. Git's generated `Revert "…"` subject is rejected on
  purpose: the type `revert:` is what the brief lists.

### Reviewer agent

`.claude/agents/security-reviewer.md`: frontmatter `name`, `description`, `model: inherit` and
`tools: Read, Grep, Glob`. Without Bash it cannot run `git diff`, so the caller passes the changed
files; the prompt says so and forbids claiming that anything was run.

### rules.yaml

Minimal edits, no new rule: `settings` added to the enforcers of SEC-003 and QUAL-002, and the
`check` texts of SEC-003, GIT-001, GIT-002 and QUAL-002 now name the real scripts and deny rules.
The rule list is a contract pinned by `tests/rules-check/schema.test.ts` (it failed when a
`QUAL-003` for the lockfile was tried), so the lockfile guard cites section 6.3 of the brief
instead of a rule id. `tests/hooks/governance.test.ts` fails when
`CLAUDE.md`, the agent, the hook scripts or `.husky/*` quote a rule id that `rules.yaml` does not
have, when `.claude/settings.json` loses a required deny rule or points at a missing script, and
when `CLAUDE.md` names an npm script that does not exist (`quality` is accepted only while
`CLAUDE.md` says it arrives in Phase 8).

## Evidence

- Payloads piped into `pre-edit.sh`. Env files (also upper case, relative to `cwd`, as
  `notebook_path`, inside `edits`, behind a dangling symbolic link) and the lockfile: exit 2 with
  the message. `.env.example`, a source file, a payload without a path: exit 0 in silence. An
  unreadable payload: exit 2.
- Payloads piped into `post-edit.sh`. An unformatted file: formatted, exit 0, silent. A lint error,
  a rules violation, a syntax error: exit 2 with the report. Markdown, an unknown file type, a
  deleted file, a directory, a file outside the repository, a file ESLint ignores, a bad payload:
  exit 0.
- Both scripts give the same results under `/bin/dash`.
- First headless run: `claude -p` with `--setting-sources project`,
  `--permission-mode acceptEdits`, `--permission-prompts none`, `--output-format stream-json` and
  `--include-hook-events`, asked to write an
  unformatted `.ts` file and `.env.local`: `PreToolUse:Write` exit 0 and `PostToolUse:Write` exit 0,
  the file came out formatted; `.env.local` was refused by the deny rule and was not created.
- Second headless run, asked to write `.env.hookprobe`, a nested `package-lock.json` and a `.ts`
  file with a banned suppression: two `PreToolUse:Write` blocks with exit 2 and the messages above
  as the tool result; `PostToolUse:Write` exit 2, and the model quoted the ESLint and the QUAL-001
  report in its answer.
- `claude -p --agent security-reviewer`: the init message lists the agent, and its tools are
  exactly `Read`, `Grep`, `Glob`.
- `npm run prepare` here: hooks installed, `core.hooksPath` is `.husky/_`. In a directory without
  `.git`, in one with `.git` but without husky, and with `HUSKY=0`: skipped with exit 0.
- `sh .husky/_/pre-commit`, which is what git runs, with a staged unformatted `.ts` and `.md` file
  and no commit: 0.7 s, both formatted and staged again, the backup stash dropped.
- `npx lint-staged --no-stash` with a staged ESLint error, then with a staged TEST-001 violation
  that ESLint does not see: exit 1 both times, the second from the rules check alone.
- `sh .husky/commit-msg <file>` with three good and three bad subjects: 0, 0, 0, 1, 1, 1.
- `tests/hooks/*.test.ts` (89 tests) keeps the scripts, the settings and the cross references
  working.

All scratch files were unstaged and deleted; nothing was committed.

## Consequences

- The edit hooks and the permission rules apply to every Claude Code session started in this
  checkout, and since `npm run prepare` was run here, `git commit` now runs lint-staged and the
  commit-msg check.
- A later edit of `eslint.config.mjs` ignores or of the deny list has to keep
  `tests/hooks/governance.test.ts` and `rules.yaml` in step; that is the point of the test.
- `.claude/settings.local.json` is personal and is not in `.gitignore` yet (not owned by this task).
