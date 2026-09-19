#!/bin/sh
# PreToolUse hook for Edit, Write, MultiEdit and NotebookEdit (wired in .claude/settings.json).
#
# Blocks, before the tool runs:
#   - real environment files: .env and every .env.* except .env.example   (rules.yaml SEC-003, FA-3)
#   - hand edits of package-lock.json                                      (brief 6.3; npm owns it)
#
# Contract (Claude Code hooks reference): the JSON payload arrives on stdin; exit 0 lets the tool
# call continue through the normal permission flow; exit 2 blocks it and the text on stderr is
# what the agent is told. Any other exit code would NOT block, so this script only uses 0 and 2.
# A payload that cannot be read blocks as well: a guard that cannot see must not wave things on.
#
# Try it:  printf '{"tool_name":"Write","tool_input":{"file_path":"%s/.env.local"}}' "$PWD" \
#            | sh scripts/hooks/pre-edit.sh; echo "exit=$?"
set -u

HOOK_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || {
  echo "pre-edit hook: cannot locate scripts/hooks; refusing the edit." >&2
  exit 2
}

if ! command -v node >/dev/null 2>&1; then
  echo "pre-edit hook: node is not on PATH, so the tool payload cannot be read; refusing the edit." >&2
  exit 2
fi

paths=$(node "$HOOK_DIR/payload-paths.mjs" --for-guard)
status=$?
if [ "$status" -eq 4 ]; then
  echo "BLOCKED by scripts/hooks/pre-edit.sh: the file path contains a line break. Use a plain file name." >&2
  exit 2
elif [ "$status" -ne 0 ]; then
  echo "BLOCKED by scripts/hooks/pre-edit.sh: the tool payload could not be read (payload-paths.mjs exit $status), so the path could not be checked. Run the script by hand with a sample payload to see why." >&2
  exit 2
fi

while IFS= read -r file; do
  [ -n "$file" ] || continue
  # The file system of macOS ignores case, so .ENV.local is .env.local.
  name=$(printf '%s' "${file##*/}" | tr '[:upper:]' '[:lower:]')
  case "$name" in
    .env.example)
      ;;
    .env | .env.*)
      {
        echo "BLOCKED by scripts/hooks/pre-edit.sh (rules.yaml SEC-003, forbidden action FA-3): $file is a real environment file."
        echo "A session never reads, creates or edits .env, .env.local, .env.sonar or any other .env.* file; they hold the owner's secrets."
        echo "Do this instead: document the variable in .env.example with an empty value, and tell the owner which value to set."
      } >&2
      exit 2
      ;;
    package-lock.json)
      {
        echo "BLOCKED by scripts/hooks/pre-edit.sh: $file is written by npm, never by hand. A hand-edited lockfile no longer matches what npm resolves."
        echo "Do this instead: change package.json and let npm regenerate the lockfile (npm install, or npm install <package>), then check the diff."
      } >&2
      exit 2
      ;;
  esac
done <<EOF
$paths
EOF

exit 0
