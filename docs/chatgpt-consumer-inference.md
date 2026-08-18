# ChatGPT Consumer Web Inference

## Goal

Superhuman can use the player's authenticated ChatGPT consumer session as a browser-backed inference provider without introducing an OpenAI API dependency.

Runtime flow:

`GENERATE TODAY'S QUEST -> Supabase inference job -> trusted browser worker -> chatgpt.com -> correlated structured response -> Superhuman validators -> atomic persistence -> Daily Quest UI`

## Rollout status

The provider, worker, queue migration, UI wiring, and tests are implemented on `agent/ai-quest-system`.

`supabase/sql/add_consumer_chatgpt_inference.sql` is intentionally **staged only** in this implementation slice. It has not been applied to production, so the current production app/database are not silently switched to consumer-browser inference by this branch work.

A real ChatGPT consumer-session E2E also requires the player's persistent browser profile on the worker host. Repository/build validation cannot fabricate that authenticated session.

The consumer website is an external UI dependency rather than a stable provider API. DOM or authentication-flow changes can require selector/transport maintenance; those changes stay isolated inside the browser transport instead of leaking into the Superhuman domain model.

Repository validation for this slice covers correlated payload parsing, prompt-injection boundaries, existing provenance validation, UI compilation, and the queue pgTAP specification. It does not claim a live consumer-session browser run until the real player profile is available on the worker host.

## Why this is a worker, not browser automation inside Next.js

The ChatGPT session is a privileged credential boundary. It must not be exposed to the browser-facing Superhuman app or stored in Supabase. A dedicated worker owns a persistent browser profile outside the repository and claims jobs through service-role-only RPCs.

This gives the system:

- persistent authenticated browser session
- headless execution after one-time login
- queue/lease semantics
- crash recovery
- bounded context retrieval
- schema validation before persistence
- retry without duplicate quest batches
- a clear place to handle consumer UI changes without coupling domain logic to selectors

## Request lifecycle

1. Authenticated player presses `GENERATE TODAY'S QUEST`.
2. `request_progression_cycle(date)` returns the single job for that player/date or safely requeues a failed/blocked job.
3. Browser worker atomically claims a queued/stale job with a lease.
4. Worker selects at most a bounded number of pending raw knowledge-entry IDs.
5. If pending raw evidence exists, the existing `derivePlayerUnderstanding` orchestration runs through `ChatGptConsumerWebProvider`.
6. Derived output is schema-validated and provenance-checked before `persist_derived_understanding` writes understanding/signals.
7. `generateDailyQuests` retrieves bounded signals + recent quest results without loading raw Vault text.
8. Provider opens a fresh ChatGPT conversation and sends a correlation-enveloped prompt.
9. Worker reads only the visible assistant response, waits for stable completion, and extracts the JSON envelope.
10. Envelope must match exact request ID, operation, and schema version.
11. Existing Daily Quest validator requires source signal provenance.
12. Existing `persist_daily_quest_batch` remains the canonical one-batch-per-player/date idempotency boundary.
13. Job becomes `succeeded`; UI reloads persisted `daily_quests`.

## Prompt-injection boundary

Player knowledge is treated as untrusted data. The consumer prompt explicitly states that content inside `CONTEXT_DATA` is data, not instructions. The provider does not expose tools to the model and the worker ignores any response that does not match the expected correlation envelope and schema.

This does not replace output validation: domain validators and ownership/provenance checks remain authoritative.

## Reasoning provenance

Superhuman does not attempt to extract private chain-of-thought. Traceability comes from explicit product-level provenance:

- `sourceKnowledgeEntryIds` for derived understanding
- `understanding_sources`
- normalized `player_signals`
- `sourceSignalIds` for generated quests
- `quest_signal_sources`
- provider/model/request audit fields
- inference-job conversation references

## Reliability model

### Session expired

Composer cannot be found and login UI is detected -> `blocked_auth`. No Life Vault or quest mutation occurs for that invocation. Re-authenticate the dedicated browser profile, then request generation again.

### Loading / browser challenge / timeout

Job is returned to `queued` with exponential backoff while attempt budget remains. A lease heartbeat prevents another worker from claiming a healthy long-running generation.

### Malformed or wrong response

JSON parse error, correlation mismatch, operation/schema mismatch, or provenance/schema validation failure -> retry. Persistence is not called for the invalid payload.

### Worker crash

`running` job becomes reclaimable after `lease_expires_at`.

### Duplicate click / retry

`ai_inference_jobs` is unique per player/operation/date. Daily Quest persistence is additionally unique at `quest_batches(user_id, quest_date)`. Repeated execution returns the already persisted quest batch.

## Credential handling

- ChatGPT username/password are never stored by Superhuman.
- Browser cookies remain inside the dedicated Chromium user-data directory.
- The profile directory must stay outside the repository and should use owner-only filesystem permissions.
- Supabase service credentials belong in the worker process secret manager/environment and are never `NEXT_PUBLIC_*`.
- The frontend can only request/read its own job through authenticated RLS/RPC boundaries.

## Operational boundary

The Next.js/Vercel deployment can enqueue and display jobs, but it should not host this browser session. Run the consumer worker on infrastructure that supports a persistent filesystem and Chromium process (for example a private workstation, VM, or dedicated worker host). Supabase remains canonical, so worker location does not change application ownership rules.
