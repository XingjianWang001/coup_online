#!/usr/bin/env bash
# PostToolUse: typecheck the edited package and run the tests that import the edited file.
# Only the edited package is checked; cross-package breakage is left to `pnpm typecheck` / CI.
f=$(jq -r '.tool_input.file_path // empty')
[[ $f =~ /packages/([a-z]+)/src/.*\.tsx?$ ]] || exit 0
cd "$CLAUDE_PROJECT_DIR/packages/${BASH_REMATCH[1]}" || exit 0
out=$( { pnpm exec tsc --noEmit && pnpm exec vitest related "$f" --run --passWithNoTests; } 2>&1 ) \
  || { echo "$out" | tail -40 >&2; exit 2; }
