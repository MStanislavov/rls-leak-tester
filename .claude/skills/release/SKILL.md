---
name: release
description: Use when the owner asks to cut, prepare or tag a version of RLS Leak Tester, to write the changelog for one, or asks what is left before it can go live on the production domain.
---

# Release

A release here is a version, a changelog, a green gate and a local tag. It never deploys and never
pushes: no `git push`, no `git remote` change, no Vercel or Supabase CLI, no DNS, no account (FA-1, FA-2,
GIT-002). The owner does those by hand from `docs/DEPLOY.md`.

## Steps

1. Clean tree on `main`: `git status --short` prints nothing.
2. Pick the version from the commits since the last tag (GIT-001 types): a `!` or
   `BREAKING CHANGE` is major, `feat` minor, anything else patch.

```sh
git tag --list 'v*' --sort=-v:refname | head -1
git log --oneline <last tag>..HEAD            # no tag yet: the whole log
npm version <x.y.z> --no-git-tag-version      # package.json and lockfile, through npm only
```

3. `CHANGELOG.md` (create it if missing): a section `## <x.y.z> - <date>` on top with Added,
   Changed, Fixed, Security, written for a user from that log. No marketing, nothing the log does
   not show.
4. The full gate, with Sonar. `--no-sonar` is not a release gate. Then the two proofs on a real
   Postgres (Docker):

```sh
npm run quality
sh scripts/verify-export-postgres.sh
sh scripts/self-isolation/verify-postgres.sh
```

Red: use the quality-gate skill. Do not tag (QUAL-002, FA-7).

5. The diff since the last tag touches `src/lib/ai`, `src/app/api`, `src/proxy.ts`, headers, SQL
   execution, `src/lib/redis`, `src/lib/store` or `supabase/migrations`: run the
   `security-reviewer` agent and act on every blocker and major finding, then repeat step 4.
6. Commit and tag. Never `--amend`, never `-f`; a wrong tag is reported, not moved.

```sh
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): v<x.y.z>"
git tag -a v<x.y.z> -m "v<x.y.z>"             # prompts: the owner approves the tag
```

7. Hand over: the version, the gate's last line as you read it, and `docs/DEPLOY.md` as the
   owner's checklist, naming every step that changed since the last release (new environment
   variable, new migration, new redirect URL). Pushing the tag is the owner's first step.
