#!/usr/bin/env bash
# PreToolUse: CI installs with --frozen-lockfile, so the lockfile only changes through pnpm.
[[ $(jq -r '.tool_input.file_path // empty') == *pnpm-lock.yaml ]] || exit 0
echo "Don't edit pnpm-lock.yaml by hand; change package.json and run pnpm install." >&2
exit 2
