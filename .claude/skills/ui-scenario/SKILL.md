---
name: ui-scenario
description: Write and run a `pnpm ui-check` browser scenario to verify a client UI change in real headless Chrome with socket.io bot players. Use whenever a UI change needs browser verification, a screenshot, or animation frames.
---
# ui-check scenarios

`pnpm ui-check [scenario.mjs] [out-dir]` builds the client, starts its own server and headless Chrome on free ports, runs the scenario, and tears everything down. It never touches the dev servers on 8787/5173. Without a scenario it runs the built-in one: a bot creates a room, the human joins, the bot starts the game, deal frames are captured.

Put throwaway scenarios in the scratchpad, not the repo. Screenshots default to `$TMPDIR/coup-ui-check-shots`; read the PNGs to judge the result. The whole run times out at 100s, each step at 10s.

## Scenario shape

```js
export default async (ui) => { /* ... */ };
```

## `ui` API

| Member | Use |
| --- | --- |
| `url`, `out` | server origin, screenshot dir |
| `goto(path)` | navigate the human player's page |
| `waitFor(selector, ms?)` | poll until the selector exists; prefer over sleeps |
| `click(textRegex, scope?)` | click the first `button` under `scope` whose text matches; give both locales, e.g. `'Join\|加入'` |
| `type(selector, value)` | set a controlled React input |
| `key(key)` | dispatch keyDown/keyUp |
| `evaluate(expr)` | run an expression in the page (wrapped in an async fn, returns by value) |
| `shot(name)` | screenshot to `out/name.png` |
| `frames(prefix, msList)` | pause all animations, seek to each time, screenshot each, then finish them |
| `joinAs(name, roomCode)` | human joins via the invite link |
| `bot()` | socket.io player: `intent(ClientIntent)`, `next(event, ms?)` resolves with the next message of that type, `state` holds latest `pub`, `hand`, `playerId` |
| `cdp(method, params)` | raw Chrome DevTools Protocol |

Intents are `ClientIntent` in `packages/shared/src/protocol.ts`; server message types are `ServerMessage` there.

## Environment

`W`/`H` viewport (default 1280×800), `MOBILE=1` touch phone emulation, `REDUCED=1` reduced motion, `LOCALE=zh-CN|en`, `NO_BUILD=1` skip the client build when it is already current, `CHROME` browser path.

## Example

`example.mjs` next to this file: start a game, then let whoever moves first take Income and capture the result. Run it with `pnpm ui-check .claude/skills/ui-scenario/example.mjs`.

Register the bot's `next(...)` before sending the intent that triggers the message, or the message can arrive before the listener. Every room change pushes a fresh `lobby`/`publicState` (including `createRoom` itself), so wait for the content you need, not just the next message of a type.
