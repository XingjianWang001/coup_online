# Project workflow

## Commands

`pnpm test`, `pnpm typecheck`, and `pnpm build:client` are what CI runs. Run one package with `pnpm --filter @coup/<engine|shared|server|client> test`. `pnpm smoke` needs `pnpm dev:server` already running.

Package flow: `engine` (pure rules, no I/O) → `shared` (protocol) → `server` (authoritative) and `client` (sends Intents only).

## Branches

`dev` is the integration branch: branch from it and open PRs against it. `main` is still the initial commit.

## Review rules

Read `CODING_STANDARDS.md` before writing or reviewing tests; it holds the judgement rules that tests and types can't enforce.

## Shared Claude Code config

`.gitignore` ignores `.claude/` except an allowlist (settings, hooks, `protocol-flow-reviewer`, `ui-scenario`). To share a new skill or agent, add a `!` entry there; otherwise it stays local.
