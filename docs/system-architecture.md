# Superhuman Progression System Architecture

## Product loop

Superhuman is moving from a user-authored checklist into a player progression system:

`Player Knowledge -> Derived Understanding -> Signals -> Retrieved Context -> Daily Quests -> Quest Results -> next context`

The System must never treat random task generation as intelligence. A quest is valid only when it is traceable to current player context.

## Trust and ownership boundary

- Supabase Auth UUID is the canonical player owner ID.
- Existing `public.users.id` values are retained and Auth users are provisioned with those same UUIDs.
- Human-readable `[username]` routes are presentation only, never authorization.
- RLS checks `auth.uid()` against the row `user_id`.
- Sensitive processing persistence RPCs are service-role only and must be called only from trusted server code after authenticating the player.
- Browser writes are limited to explicit player-owned surfaces such as raw manual knowledge ingestion and quest completion/result state.

## Layer 1: Raw Player Knowledge

### `knowledge_sources`
Represents where knowledge came from. Supported foundation types include life update, note, journal, goal, relationship, career, wellness, document, and future integration sources.

Document/integration support begins as metadata (`external_ref`, `metadata`) so binary storage or a provider-specific connector does not leak into the domain model.

### `knowledge_entries`
Stores raw player-owned evidence. Raw text is intentionally separate from AI conclusions and carries its own processing state.

Example:

> Interview gue tadi gagal karena system design.

This is stored as evidence first. The database does not automatically label it an obstacle.

## Layer 2: Derived Understanding

### `derived_understanding`
Stores evidence-backed interpretation such as:

- goal
- obstacle
- opportunity
- constraint
- preference
- relationship
- event
- priority

Every record stores extraction version and optional provider/model/request audit fields.

### `understanding_sources`
Many-to-many provenance from an understanding back to the raw knowledge entries that support it. A model output without source knowledge IDs is rejected before persistence.

## Layer 3: Player Signals

### `player_signals`
A normalized, retrieval-friendly representation of current progression needs. Signals carry type, importance, confidence, observation time, optional expiry, and source understanding.

This layer is deliberately smaller than the Life Vault. Daily Quest generation consumes signals rather than dumping the full raw Vault into a model request.

## Layer 4: Bounded Context Retrieval

### Understanding context
`BoundedPlayerContextRetriever.retrieveForUnderstanding` loads only explicitly selected raw knowledge entries plus a small number of recent signals.

It does not scan the entire Life Vault.

### Daily Quest context
`BoundedPlayerContextRetriever.retrieveForDailyQuest` loads active derived signals plus recent quest results.

It loads **zero raw Life Vault entries** by default.

### Context snapshots
`context_snapshots` records the exact bounded context used for an AI operation. Provenance joins record included raw knowledge, signals, and recent quest outcomes together with retrieval strategy and model audit metadata.

This makes model decisions auditable and reproducible at the context level without storing an opaque magical player state.

## AI provider boundary

The domain depends on `AiProvider`, not OpenAI, ChatGPT, or another vendor SDK.

The orchestration boundary is intentionally split into:

1. context retrieval
2. provider invocation
3. structured output validation
4. persistence

There is no random/fake fallback when a provider is unavailable. Generation stops instead.

Understanding output must cite `sourceKnowledgeEntryIds` from retrieved context. Daily Quest output must cite `sourceSignalIds` from retrieved context.

## Daily Quest persistence

### `quest_batches`
One batch per `user_id + quest_date`. This is the idempotency boundary that prevents quests from changing on refresh.

### `daily_quests`
Stores generated quests with category, kind, difficulty, priority, XP, rationale, source, and status.

### `quest_signal_sources`
Links every generated quest to the signals that justified it.

### `quest_results`
Stores completion/partial/skipped/failed outcomes and optional player notes. Recent results become input to future bounded Daily Quest context.

## Legacy compatibility

Existing `checklist_items` and `daily_logs` remain intact. The current Daily Quest screen maps existing checklist items through `legacyItemToQuest`, so completion history and streak behavior are preserved while the new model is introduced in parallel.

The new `daily_quests` schema supports `source = 'legacy'` for a future controlled backfill/projection if needed. No destructive backfill is required for the security or Life Vault rollout.

## Rollout order

Production rollout is intentionally ordered and guarded:

1. receive explicit email mapping for both legacy players
2. provision Supabase Auth users with exact existing UUIDs
3. verify Auth redirect configuration
4. baseline the existing remote database with Supabase CLI migration history
5. apply Auth ownership/RLS hardening
6. run RLS + regression verification
7. apply Player Knowledge foundation
8. apply progression provenance/persistence layer
9. run Life Vault/RLS/progression pgTAP tests and post-rollout verification
10. verify manual Life Vault ingestion with both real players
11. only then wire a real AI provider and production processing worker/server path

Each staged Life Vault migration assumes the previous security layer is already passing. Production currently remains on the legacy schema until the email/approval blocker is resolved.
