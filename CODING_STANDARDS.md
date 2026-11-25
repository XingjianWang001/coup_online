# Coding standards

Review-time rules that need judgement. Mechanical rules belong in tests, types, or CI instead.

## Tests replay real message flows

Client tests feed `reduceSession` only message sequences recorded from the real server: `packages/server/src/message-flows.test.ts` plays flows through a real `Room` and `publish()` (`packages/server/src/push.ts`) and writes what each connection received to `packages/shared/fixtures/message-flows.json`. That test fails when the server's output drifts from the fixture; check the new order, then run `pnpm fixtures` to regenerate and rerun the client tests. A case the flows don't cover gets a new step or flow there, not a hand-written sequence.

Flag a hand-written `publish()` sequence (`events`, `publicState`, `privateState`, `lobby`, `gameStarted`, `joined`) in a client test. Single messages the transport sends on its own (`error`, `left`, `tunnelUrl`, `showdownFocus`) may stay literal.

## Cross-file contracts live in code, not comments

A comment like "keep this in sync with X in another file" is a contract nothing enforces. Put the value in `@coup/shared` and import it on both sides, or add a test that fails when the two drift (see `REVEAL_STEPS_MS` in `packages/client/src/motion.ts`). Flag new sync comments in review.

Socket input enters the server only through `parseClientIntent`. Room and engine code takes typed intents and checks game rules, never field shapes; a new `as` on client-supplied data is a review finding.
