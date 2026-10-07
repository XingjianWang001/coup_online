# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations and infer the repository from the current Git remote.

## Conventions

- Create, read, comment on, label, and close issues through `gh issue`.
- When a skill says “publish to the issue tracker,” create a GitHub issue.
- When a skill says “fetch the relevant ticket,” read the complete issue body, labels, and comments.
- Pull requests are not treated as a triage request surface.
- Specs and implementation tickets use the `ready-for-agent` label.
- Publish dependent tickets in dependency order.
- Represent blocking relationships with GitHub native issue dependencies when available; otherwise include `Blocked by: #<issue>` in the issue body.
