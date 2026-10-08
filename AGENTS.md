# Repository guidance

@.clinerules/ponytail.md

## Commits

Use Conventional Commits: `<type>(<optional-scope>): <imperative summary>`. Prefer the narrowest package scope for package-specific changes, such as `feat(client): animate transient notice dismissal`.

## Windows sandbox recovery

If a sandbox command fails before launch with `setup refresh had errors`, ask the user to restart Codex, then retry a harmless command in the sandbox. Read the sandbox log only if restarting does not resolve it.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues for `XingjianWang001/coup_online`. See `docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single-context domain layout. See `docs/agents/domain.md`.
