# Coding standards

Review-time rules that need judgement. Mechanical rules belong in tests, types, or CI instead.

## Tests replay real message flows

Client tests that feed `ServerMessage` sequences into `reduceSession` must use sequences the server can actually emit. Check them against the push order in `publish()` and `broadcast()` (`packages/server/src/index.ts`) and against the engine's phase transitions (`packages/engine/src/game.ts`). For example, a lost Challenge enters `choosingLoss` and never ends the Game in the same publish.

A test built on an impossible sequence passes by construction and hides the real flow. Flag it even when the assertion looks right.
