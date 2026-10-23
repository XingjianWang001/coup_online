# Repository guidance

@.clinerules/ponytail.md

@CLAUDE.md

## Commits

Use Conventional Commits: `<type>(<optional-scope>): <imperative summary>`. Prefer the narrowest package scope for package-specific changes, such as `feat(client): animate transient notice dismissal`.

## UI verification

Verify UI changes in a real browser with `pnpm ui-check [scenario.mjs] [out-dir]`; the header of `scripts/ui-check.mjs` documents scenarios and options. It runs its own server and headless Chrome on free ports and tears them down on exit, keeping the user's dev servers on 8787/5173 free for manual testing.

## Design prototypes

Design explorations are archived on `prototype/*` branches. Each archive commit message records the variants and the verdict, including drafts saved for later (`git log main..prototype/<name>`).

## Windows sandbox recovery

If a sandbox command fails before launch with `setup refresh had errors`, ask the user to restart Codex, then retry a harmless command in the sandbox. Read the sandbox log only if restarting does not resolve it.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues for `XingjianWang001/coup_online`. See `docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single-context domain layout. See `docs/agents/domain.md`.
