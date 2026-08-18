# Superhuman Progression System Architecture

## Product loop

Superhuman is an AI personal progression system, not a user-authored checklist.

Baseline loop:

`Player Knowledge -> Derived Understanding -> Signals -> Retrieved Context -> Daily Quest -> Quest Results -> future context`

After a Daily Quest already exists, new knowledge follows a second loop:

`New Knowledge -> Understanding -> Materiality Assessment -> no change | suggestion | System Interrupt -> Quest Results -> future context`

The System must never treat random task generation as intelligence. Every generated or revised quest must remain traceable to current player context.

## Core product invariant: stable by default

A Daily Quest batch is persistent for the player/date and does not reshuffle on refresh or every journal update.

New knowledge is always allowed to improve player understanding, but it changes today only when it is both important and time-sensitive enough to justify an explicit revision. Ordinary journaling, background detail, mild mood changes, and long-term insights normally affect future progression rather than silently rewriting today.

## Trust and ownership boundary

- Supabase Auth UUID is the canonical player owner ID.
- `public.users.id` uses that same UUID.
- Human-readable `[username]` routes are presentation only, never authorization.
- RLS checks `auth.uid()` against row `user_id`.
- Sensitive AI persistence RPCs are service-role only.
- Browser writes are restricted to owner-scoped player actions such as Life Vault ingestion, quest completion, and applying a suggested adjustment.
- Raw Life Vault content is untrusted model input. Consumer ChatGPT prompts explicitly prohibit following instructions embedded in player context.

## Layer 1: Raw Player Knowledge

### `knowledge_sources`

Represents where evidence came from: life update, note, journal, goal, relationship, career, wellness, document, or future integrations.

### `knowledge_entries`

Stores raw player-owned evidence separately from AI conclusions.

Processing state tracks understanding ingestion. `materiality_status` separately tracks whether a newly understood update has been checked against an already-existing Daily Quest.

A failed provider/transport request never means the player should rewrite or duplicate their knowledge entry.

## Layer 2: Derived Understanding

### `derived_understanding`

Stores evidence-backed interpretation such as goals, obstacles, opportunities, constraints, preferences, relationships, events, and priorities.

### `understanding_sources`

Many-to-many provenance back to raw knowledge. Model output without valid source knowledge IDs is rejected.

When newly processed understanding references a knowledge entry, that entry becomes eligible for materiality assessment if a Daily Quest already existed before the update was processed.

## Layer 3: Player Signals

### `player_signals`

A normalized retrieval-friendly representation of progression needs. Signals carry type, importance, confidence, observation time, optional expiry, and source understanding.

Daily Quest and System Interrupt generation consume signals instead of dumping the whole raw Life Vault into every request.

## Layer 4: Bounded Context Retrieval

### Understanding

`retrieveForUnderstanding` loads only explicitly selected raw knowledge plus a small recent-signal window.

### Baseline Daily Quest

`retrieveForDailyQuest` loads active signals plus recent quest results and no raw Life Vault entries by default.

### Materiality

`retrieveForMateriality` loads:

- exactly the new knowledge entry that triggered the check
- relevant current signals
- recent quest results
- currently mutable Daily Quests (`pending` / `partial`)
- player timezone
- the current local player datetime

This lets the model judge same-day urgency without scanning all historical data.

### System Interrupt

`retrieveForSystemInterrupt` uses the persisted materiality decision plus the current mutable quests and bounded supporting signals. The planner is instructed to make the smallest explicit revision required, never regenerate the entire day.

### Context snapshots

`context_snapshots` records the bounded context and model audit metadata used by each operation.

Provenance joins include:

- `context_snapshot_knowledge`
- `context_snapshot_signals`
- `context_snapshot_quest_results`
- `context_snapshot_quests`

This preserves exactly what the System compared when it decided to keep or revise today's plan.

## AI provider boundary

The domain depends on `AiProvider`, not a vendor SDK.

Current production provider is the authenticated consumer ChatGPT browser worker, but the domain orchestration remains provider-neutral.

Every request has:

1. bounded context retrieval
2. provider invocation
3. strict correlation / operation / schema validation
4. domain validation
5. transactional persistence

No random/fake fallback is allowed.

Operations currently include:

- `derive_understanding`
- `generate_daily_quests`
- `assess_materiality`
- `generate_system_interrupt`

## Baseline Daily Quest persistence

### `quest_batches`

One row per `user_id + quest_date`. This is the baseline idempotency boundary.

### `daily_quests`

Stores both the original quest set and later explicit revisions.

Active/completion statuses:

- `pending`
- `partial`
- `completed`

Historical/terminal adjustment statuses:

- `deferred`
- `cancelled`
- `replaced`
- `skipped`
- `failed`

Revision metadata includes revision number, superseded quest, interrupt/materiality references, interrupt timestamp, and reason. Existing rows are never deleted to represent a revision.

### `quest_signal_sources`

Links every AI/system-created quest to supporting signals.

### `quest_results`

Stores player outcomes. Recent results remain input to future progression.

## Materiality Assessment

### `materiality_assessments`

One auditable decision per player + triggering knowledge + target date + assessment version.

It persists:

- `is_material`
- level (`low | medium | high | critical`)
- confidence
- reason
- affected quest IDs
- source signal IDs
- recommended action
- urgency
- final disposition
- provider/model/request/version
- player timezone/local datetime
- exact context snapshot

### Decision policy

The model performs semantic assessment; thresholds only decide how a validated model decision is executed.

Current execution thresholds:

- non-material, no urgency, or confidence `< 0.65` -> `no_change`
- high/critical + confidence `>= 0.85` + today/immediate urgency -> `auto_interrupt`
- other material assessments with sufficient confidence -> `suggest`

A non-material result updates understanding/signals but does not mutate today's quests.

## System Interrupt

### `quest_interrupts`

One interrupt plan per materiality assessment. Unique assessment linkage makes retries idempotent.

Status:

- `suggested`
- `applied`

### `quest_interrupt_actions`

Persists an ordered, reconstructable audit trail for:

- ADD
- REPLACE
- DEFER
- CANCEL
- REPRIORITIZE

Each action stores target/result quest references, reason, optional new priority/new-quest payload, and before/after state.

### Mutation rules

- ADD creates one explicit system quest while preserving existing quests.
- REPLACE marks the old quest historical and creates a linked replacement.
- DEFER keeps the original quest but removes it from today's active set.
- CANCEL is terminal and should be used more conservatively than defer.
- REPRIORITIZE changes order without recreating the quest.
- completed/historical quests are never rewritten retroactively.
- if a suggested interrupt targets a quest that becomes completed before apply, the action is safely skipped and the audit records `target_completed`.
- advisory transaction locks serialize materiality/interrupt mutations per player/date.

## UX contract

### Life Vault

After save:

1. knowledge is persisted immediately
2. `SYSTEM PROCESSING`
3. understanding refreshes
4. if a baseline quest existed, `CHECKING TODAY`
5. then one of:
   - `UPDATED · QUESTS UNCHANGED`
   - `ADJUSTMENT SUGGESTED`
   - `SYSTEM INTERRUPT`

Transport/model failure does not tell the player to add more context unless the actual error is insufficient context.

### Today

The main experience remains simple:

- current active quests stay visible while new context is processed
- auto-applied material changes surface as `⚠ SYSTEM INTERRUPT`
- medium-confidence changes surface as `SYSTEM SUGGESTION` with `APPLY ADJUSTMENT`
- interrupted historical quests appear secondarily under `ADJUSTED TODAY`
- detailed provenance remains in persistence/history rather than cluttering the main quest list

## Consumer ChatGPT production runtime

Production reasoning is processed by the VPS worker:

`Supabase queue -> superhuman-vps-ubuntu -> persistent Chrome/ChatGPT session -> validated domain persistence`

The browser runs headful inside Xvfb and exposes CDP only locally. The worker is managed by systemd.

Provider rate-limit overlays are detected explicitly and treated as retryable transport conditions. Player context remains persisted and should not be re-entered.

## Idempotency and retry boundaries

- one inference job per player + operation + date
- one baseline quest batch per player + date
- one materiality assessment per trigger knowledge + date + assessment version
- one interrupt per materiality assessment
- applied interrupts are idempotent
- model/provider retries resume from already-persisted assessments instead of duplicating revision effects
- database locks and ownership validation protect close-together knowledge updates and stale target quests

## Rollout verification

A materiality/System Interrupt release is complete only after:

1. domain tests pass
2. lint and production build pass
3. schema migration is applied to the canonical `superhuman` project
4. transactional database tests prove no-change, interrupt, retry-idempotency, and completed-history protection
5. production Vercel deployment is READY
6. VPS worker checkout is updated and services remain active
7. a real Life Vault update proves end-to-end materiality behavior through the production consumer ChatGPT provider
