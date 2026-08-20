# AI Testing Policy

Superhuman separates deterministic product testing from live-model validation.

## Default developer path

`npm test` is mock-only.

- Use `FakeAiProvider` from `lib/ai/fake-ai-provider.ts`.
- Prepare deterministic fixtures for each expected `AiOperation`.
- Reuse the normal orchestration, validators, scoring, persistence adapters, and idempotency rules.
- Unexpected model calls fail immediately instead of falling back to a live provider.
- `npm test` runs `scripts/assert-no-live-ai-tests.mjs` before the suite. Ordinary tests are rejected if they directly import/construct the Playwright ChatGPT transport or opt into live smoke mode.

This is the normal path for regression and integration coverage, including Player Brief deltas, Progression Map, Player Response Model, Progression Target, Quest Policy, materiality/interrupt decisions, and persistence/idempotency behavior.

## Production reasoning

Production uses the same `AiProvider` contract through `RealAiProvider` (`ChatGptConsumerWebProvider`) and the dedicated browser transport. Production semantics must not be reimplemented in the fake; only model outputs are substituted by fixtures.

## Live model validation

A real ChatGPT call is not part of `npm test`, `npm run build`, CI, or routine synthetic E2E.

Live-model validation is exceptional and manual:

1. State the exact behavior that cannot be proven with fixtures.
2. Use the smallest bounded non-sensitive context possible.
3. Prefer one smoke/E2E invocation rather than a full regression replay.
4. Never loop, stress-test, or repeatedly re-arm rate-limited jobs.
5. Clean up any synthetic production data immediately.

A live smoke is evidence about model/provider behavior only. It is not the primary regression harness.

## Rule of thumb

- ~95%+ of testing: `FakeAiProvider`, deterministic, zero ChatGPT traffic.
- Live provider: explicit smoke only when real-model behavior itself is the thing being validated.
