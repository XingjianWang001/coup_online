---
name: ui-scenario
description: Write and run a `pnpm ui-check` browser scenario to verify a client UI change in real headless Chrome with socket.io bot players. Use whenever a UI change needs browser verification, a screenshot, or animation frames.
---
# ui-check scenarios

The header of `scripts/ui-check.mjs` documents usage, the scenario exports (`default`, `serverEnv`) and the environment variables; the `ui` object is the `context` in its `main()`. Intents are `ClientIntent` and server messages `ServerMessage` in `packages/shared/src/protocol.ts`.

Put throwaway scenarios in the scratchpad, not the repo, and read the PNGs to judge the result.

`example.mjs` next to this file starts a game, lets whoever moves first take Income, and captures the result: `pnpm ui-check .claude/skills/ui-scenario/example.mjs`.

Register the bot's `next(...)` before sending the intent that triggers the message, or the message can arrive before the listener. Every room change pushes a fresh `lobby`/`publicState` (including `createRoom` itself), so wait for the content you need, not just the next message of a type.
