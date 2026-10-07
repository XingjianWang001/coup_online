# Domain Docs

This repository uses a single domain context.

## Before exploring

- Read the root `CONTEXT.md`.
- Read relevant decisions under `docs/adr/`.
- If either is absent, proceed without creating placeholder documentation.

## Layout

```
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── packages/
```

## Vocabulary

Use the canonical terms defined in `CONTEXT.md` in issue titles, specifications, implementation plans, and tests. Do not substitute terms listed under `_Avoid_`.

If required terminology is missing, record the gap for `domain-modeling` rather than silently inventing competing language.

## Architecture decisions

Surface any conflict with an existing ADR explicitly instead of silently overriding it.
