# ADR draft: the six skills and the final CLAUDE.md

- Status: proposed
- Date: 2026-09-20
- Phase: 9 (task D2)

## Context

Brief 6.4 asks for six skills under `.claude/skills/`, each a folder with a `SKILL.md` whose
description starts with "Use when" and states triggers only, a body under about 300 words,
concrete commands and rule ids. Brief 6.2 asks for a concise, operational `CLAUDE.md`. Until this
phase `tests/hooks/governance.test.ts` tolerated the missing `quality` script and said nothing
about skills.

## Decisions

1. **Six skills, no supporting files.** `quality-gate`, `add-template`, `add-static-check`,
   `debug-probe`, `sonar-triage`, `release`. Every command in them was run in this checkout before
   it was written down: the stage names and the failure lines come from `scripts/quality.mjs`, the
   Sonar queries were sent through `scripts/sonar/api.sh` to the running server (gate status, issue
   search with `impactSeverities` and facets, hotspot search, `api/rules/show`), and
   `npm version --no-git-tag-version` is in `npm version --help`.
2. **The debug-probe script is inline and lives outside the repository when used.** A `.ts` file
   in the skill folder would be linted, scanned by Sonar as uncovered new code, and would need an
   exclusion with a reason (QUAL-001) for no gain. The script in the skill uses `@/` imports only,
   so it runs from any path as long as the working directory is the repository root (tsx reads
   `tsconfig.json` from there). Measured: the exact text of the skill's code block, extracted and
   run with `npx tsx`, prints the cell `alice|public.todos|select` of `todos-sharing-leaky` as
   `leak`, then replays the recorded transcript statement by statement (whoami: role
   `authenticated`, session role `postgres`, `row_security` on; seven rows) in about two seconds.
   Top-level `await` does not work there (tsx compiles a `.ts` of this package as CommonJS), hence
   `async function main()`.
3. **What "a word" is.** The governance test counts tokens that contain a letter or a digit. The
   pipes and rules of a Markdown table and a lone brace of a code block are not words. By that
   count the bodies have 255 to 298 words; code blocks are included in the count.
4. **What the governance test now pins** (DOD-10): exactly the six folders; frontmatter that
   parses as YAML with exactly `name` and `description`, at most 1024 characters; `name` equals
   the folder; the description starts with "Use when", has at most 500 characters and carries no
   command, no code and no step words (`then`, `first`, `step`, a numbered list, an arrow); the
   body starts with a heading, cites at least one rule id of `rules.yaml`, contains a `sh` block,
   names only npm scripts that exist and only repository paths that exist; no skill has a push, a
   deployment CLI or a hook bypass as a step; `CLAUDE.md` lists every skill with when to use it.
   The tolerance for a missing `quality` script is gone: `quality`, `sonar` and `sonar:bootstrap`
   must be named in `CLAUDE.md` and exist, and `CLAUDE.md` may no longer announce anything for a
   later phase. Both new failure modes were seen failing on a deliberately broken skill (a
   workflow in the description, a path that does not exist) before the file was restored.
5. **`release` tags locally and stops.** `.claude/settings.json` leaves `git tag` to a prompt, so
   the owner approves the tag; the skill never pushes and hands over `docs/DEPLOY.md`, whose first
   step is the owner's push. `CHANGELOG.md` does not exist yet; the skill creates it with the
   first release.

## Deviation

The writing-skills guidance available to this session asks for a baseline run without the skill
and a pressure test with subagents before a skill ships. This session has no tool to start a
subagent, so neither was done. What was verified instead is what can be verified mechanically:
every command, path, script name and rule id, and the form of the frontmatter. The discipline
skills (`quality-gate`, `sonar-triage`, `debug-probe`) therefore carry explicit "Never" lists
taken from the failure modes the brief names (section 10, QUAL-002), not from observed
rationalisations. A later session with subagents should run one pressure scenario per skill
(a red gate late in a phase; a golden test red after a runner change; a gate red because of one
suspected false positive) and tighten the wording where an agent finds a loophole.

## Consequences

- Adding a seventh skill means adding it to `SKILLS` in the governance test and to `CLAUDE.md`.
- A renamed file or npm script that a skill names fails the governance suite, not a future
  session in the middle of a task.
