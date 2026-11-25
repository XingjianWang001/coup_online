# Repository guidance

@.clinerules/ponytail.md

@CLAUDE.md

## Commits

Use Conventional Commits: `<type>(<optional-scope>): <imperative summary>`. Prefer the narrowest package scope for package-specific changes, such as `feat(client): animate transient notice dismissal`.

Do not add AI attribution (`Co-Authored-By: Claude …`, "Generated with Claude Code") to commits or PR bodies. `.githooks/commit-msg` rejects it (`pnpm install` enables the hook).

Pull requests target `dev`, the default branch; `main` holds only the initial commit.

## UI verification

Verify UI changes in a real browser with `pnpm ui-check [scenario.mjs] [out-dir]`; the header of `scripts/ui-check.mjs` documents scenarios and options. It runs its own server and headless Chrome on free ports and tears them down on exit, keeping the user's dev servers on 8787/5173 free for manual testing.

A PR that changes what players see carries before/after screenshots in its body: shoot the same scenario on `origin/dev` and on the branch, then `pnpm pr-shots <PR> <png>...` prints the image links. The `PR screenshots` CI check enforces this; the `no-screenshot` label exempts a client change with nothing visible.

## Large output

When the `ctx_*` tools from context-mode (`mksglu/context-mode`) are loaded, keep bulky output out of context:

- Counting, filtering or searching more than about 20 lines (test or typecheck runs, `pnpm ui-check` logs, `.server.log`, CI logs, `pnpm-lock.yaml`, web pages): `ctx_execute`, or `ctx_batch` for several commands, printing only the answer.
- A result cut short: `ctx_search` the indexed remainder instead of rerunning the command.
- A resumed session: `ctx_resume` before re-reading files.

Small output and file edits stay on the ordinary tools.

## Design prototypes

Design explorations are archived on `prototype/*` branches. Each archive commit message records the variants and the verdict, including drafts saved for later (`git log main..prototype/<name>`).

## Windows sandbox recovery

If a sandbox command fails before launch with `setup refresh had errors`, ask the user to restart Codex, then retry a harmless command in the sandbox. Read the sandbox log only if restarting does not resolve it.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues for `XingjianWang001/coup_online`. See `docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single-context domain layout. See `docs/agents/domain.md`. Skills that name `GLOSSARY.md` mean `CONTEXT.md`.
