#!/bin/sh
# PostToolUse hook for Edit, Write, MultiEdit and NotebookEdit (wired in .claude/settings.json).
#
# For every file the tool call wrote, and only for that file:
#   1. prettier --write          formats it (unknown file types and .prettierignore are skipped)
#   2. eslint                    lints it when it is a JavaScript or TypeScript source file
#   3. scripts/rules-check.mjs   runs the fast rules check on it (rules.yaml)
#
# Contract (Claude Code hooks reference): the JSON payload arrives on stdin; on exit 0 nothing is
# shown to the agent; on exit 2 the text on stderr is shown to the agent next to the tool result
# (the edit itself already happened). So: silent and 0 when the file is fine, a report and 2 when
# the edited file has a real problem. It never fails for a reason that is not the edited file: a
# deleted file, a file outside the repository, a file a tool ignores, a missing tool and an
# unreadable payload all end in exit 0.
#
# Try it:  printf '{"tool_name":"Edit","tool_input":{"file_path":"%s/src/app/page.tsx"}}' "$PWD" \
#            | sh scripts/hooks/post-edit.sh; echo "exit=$?"
set -u

MAX_LINES=40

HOOK_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 0
ROOT=$(CDPATH='' cd -- "$HOOK_DIR/../.." && pwd -P) || exit 0
command -v node >/dev/null 2>&1 || exit 0

files=$(node "$HOOK_DIR/payload-paths.mjs" --existing-files 2>/dev/null) || exit 0
[ -n "$files" ] || exit 0

cd "$ROOT" || exit 0
PRETTIER="$ROOT/node_modules/.bin/prettier"
ESLINT="$ROOT/node_modules/.bin/eslint"
RULES_CHECK="$ROOT/scripts/rules-check.mjs"

report=$(mktemp "${TMPDIR:-/tmp}/post-edit-hook.XXXXXX") || exit 0
output=$(mktemp "${TMPDIR:-/tmp}/post-edit-hook.XXXXXX") || {
  rm -f "$report"
  exit 0
}
trap 'rm -f "$report" "$output" "$output.keep"' EXIT
trap 'exit 0' HUP INT TERM

# add_section <title>: appends the captured tool output, capped, under a title.
add_section() {
  {
    echo "--- $1"
    head -n "$MAX_LINES" "$output"
    total=$(wc -l <"$output" | tr -d ' ')
    if [ "$total" -gt "$MAX_LINES" ]; then
      echo "... ($((total - MAX_LINES)) more lines; run the command yourself for the rest)"
    fi
  } >>"$report"
}

while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in
    "$ROOT"/*) rel=${file#"$ROOT"/} ;;
    *) continue ;; # outside the repository: not ours to format or judge
  esac
  case "$rel" in
    node_modules/* | .git/* | .next/* | */node_modules/*) continue ;;
  esac

  # 1. Format. Exit 2 of prettier means it could not parse the file: a real problem of the file.
  if [ -x "$PRETTIER" ]; then
    "$PRETTIER" --write --ignore-unknown --log-level warn -- "$rel" >"$output" 2>&1
    if [ $? -ne 0 ]; then add_section "prettier could not format $rel"; fi
  fi

  # 2. Lint source files. A warning is reported too, because `npm run lint` and lint-staged run
  #    with --max-warnings 0; files that eslint ignores are skipped silently.
  case "$rel" in
    *.js | *.jsx | *.mjs | *.cjs | *.ts | *.tsx | *.mts | *.cts)
      if [ -x "$ESLINT" ]; then
        "$ESLINT" --max-warnings 0 --no-warn-ignored -- "$rel" >"$output" 2>&1
        if [ $? -ne 0 ]; then add_section "eslint: $rel (npx eslint $rel)"; fi
      fi
      ;;
  esac

  # 3. Fast rules check. Exit 1 means violations; anything else is not about this file.
  #    rules.yaml is validated on every run, so its own schema problems are only reported when
  #    rules.yaml is the file that was edited (npm run rules, lint-staged and CI still see them).
  if [ -f "$RULES_CHECK" ]; then
    node "$RULES_CHECK" -- "$rel" >"$output" 2>&1
    if [ $? -eq 1 ]; then
      if [ "$rel" != "rules.yaml" ]; then
        grep -v '^RULES-SCHEMA rules\.yaml:' "$output" >"$output.keep"
        mv "$output.keep" "$output"
      fi
      if grep -q -v '^rules-check (' "$output"; then
        add_section "rules check (rules.yaml): $rel (node scripts/rules-check.mjs -- $rel)"
      fi
    fi
  fi
done <<EOF
$files
EOF

if [ -s "$report" ]; then
  {
    echo "scripts/hooks/post-edit.sh: the file you just edited has problems. Fix them now, in that file; never weaken a rule to get green (rules.yaml QUAL-002)."
    cat "$report"
  } >&2
  exit 2
fi
exit 0
