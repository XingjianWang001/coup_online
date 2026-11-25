@AGENTS.md

## Shared Claude Code config

`.gitignore` ignores `.claude/` except an allowlist (`settings.json`, `hooks/`, the `ui-scenario` skill). To share a new skill or agent, add a `!` entry there; otherwise it stays local. Design hooks come from the impeccable plugin, not `settings.json`.
