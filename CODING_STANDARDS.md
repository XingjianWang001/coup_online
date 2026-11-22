# Coding standards

Review-time rules that need judgement. Mechanical rules belong in tests, types, or CI instead.

## Tests replay real message flows

Client tests that feed `ServerMessage` sequences into `reduceSession` must use sequences the server can actually emit. Check them against the push order in `publish()` and `broadcast()` (`packages/server/src/index.ts`) and against the engine's phase transitions (`packages/engine/src/game.ts`). For example, a lost Challenge enters `choosingLoss` and never ends the Game in the same publish.

A test built on an impossible sequence passes by construction and hides the real flow. Flag it even when the assertion looks right.

## Cross-file contracts live in code, not comments

A comment like "keep this in sync with X in another file" is a contract nothing enforces. Put the value in `@coup/shared` and import it on both sides, or add a test that fails when the two drift (see `REVEAL_STEPS_MS` in `packages/client/src/motion.ts`). Flag new sync comments in review.

Socket input enters the server only through `parseClientIntent`. Room and engine code takes typed intents and checks game rules, never field shapes; a new `as` on client-supplied data is a review finding.
