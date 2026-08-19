# Superhuman — Player Brief Rollout Handoff

Date: 2026-08-19
Purpose: canonical handoff for the next engineering room. Read this before making further implementation decisions.

## Project

Repository: `karkandea/superhuman`

Product direction: Superhuman is evolving from a user-authored daily checklist into an AI Personal Progression / Quest System.

Core loop:

`Player Knowledge -> AI Understanding -> Detect Goals / Obstacles / Opportunities -> Generate Daily Quests -> Player Executes -> Observe Results -> Update Understanding -> Generate Next Quests`

Mid-day flow:

`New Knowledge -> Understanding -> Materiality -> no change | suggestion | System Interrupt -> result -> future context`

Daily Quest should be stable by default and only change when new information is materially relevant.

## Canonical product mental model

The product memory architecture is now locked as:

- ChatGPT / consumer browser session = disposable reasoning worker.
- Supabase = permanent player memory.
- Life Vault = raw memory / raw evidence.
- `derived_understanding` = granular, provenance-backed current/historical understanding records.
- `player_signals` = currently relevant derived signals.
- Player Brief = compact, first-class, versioned canonical current-state snapshot for the player.
- Every fresh AI session must receive the current Player Brief plus bounded relevant context.
- Conversation history must never be treated as player memory or source of truth.
- Do not send the entire Life Vault every cycle.

Fresh-session context should conceptually be:

`Current Player Brief + Active Signals + Today Quests + Recent Quest Results + New Activity Batch + only relevant raw Vault evidence when needed`

The AI should return a state delta rather than rewriting the player's identity/state from scratch.

Understanding delta operations:

- `create`
- `update`
- `resolve`
- `supersede`
- no-op via `actions: []`

No-op is valid and should not bump Player Brief version.

## Player Brief design

Player Brief is a persistent, versioned canonical snapshot. Example mental model:

`PLAYER BRIEF — Arkan — v37`

Contains compact current-state representation such as:

- player identity metadata
- active goals
- priorities
- constraints
- relationships
- obstacles
- opportunities
- recent important events
- active signals

Granular details stay in `derived_understanding`; Player Brief is intentionally bounded and compact.

Important implementation rule: Player Brief is built deterministically by backend/database state after understanding deltas persist. AI does not freely rewrite the whole brief.

## Current production player

Canonical player UUID:

`f26ca205-54f6-43ce-9fa7-417b747faabe`

Canonical email:

`karkandea@gmail.com`

Correct Supabase project only:

- project: `superhuman`
- ref: `ispfhvdelglwvixaspza`
- region: `ap-northeast-2`
- URL: `https://ispfhvdelglwvixaspza.supabase.co`

Never touch the unrelated `duajiwa` project.

## Production infrastructure

Web:

`https://superhuman.dualangka.com`

Vercel project:

`prj_yOE5MpruVIdtO15COY3uOlERkZEh`

Vercel team:

`team_6UCG76Tzj4UwIURyL7qCfPPc`

VPS:

- host: `103.175.207.127`
- Ubuntu 22.04
- worker user: `superhuman-ai`
- repo: `/opt/superhuman`
- browser profile: `/var/lib/superhuman-ai/chatgpt-profile`
- env: `/etc/superhuman-ai/consumer-worker.env`

Services:

- `superhuman-chatgpt-browser.service`
- `superhuman-ai-worker.service`

Consumer browser path:

- browser runs headful Chrome through Xvfb
- CDP: `127.0.0.1:9222`
- browser session is persisted
- consumer ChatGPT browser path is unofficial; batching/retry logic must not be used to circumvent provider restrictions.

## Existing activity-window orchestration already live before Player Brief work

Implemented and rolled out previously:

- 2-minute debounce
- 10-minute hard max wait
- stable activity-window cutoff
- UTF-8 byte-budget knowledge batching, default 24 KB
- self-draining backlog
- one materiality decision for one activity period
- deterministic hashed materiality batch idempotency key
- provider-rate-limit circuit breaker
- manual recovery
- Life Vault batch UX

Worker v2 entrypoint:

`workers/chatgpt-consumer/worker-v2.mjs`

Previous production worker rollout was confirmed on commit:

`7eec765c311704218a75e913e4abd719d899b6fd`

At that time logs confirmed:

- browser active
- worker active
- worker entrypoint `worker-v2.mjs`
- `knowledgeBudget=24576B`
- `materialityRawBudget=24576B`
- `stagePause=5000ms`

A real isolated production canary was run for the activity-window system and passed:

- real 2-minute enqueue debounce
- worker claim after debounce
- frozen cutoff across retries
- knowledge -> understanding -> signal -> quest
- self-drained backlog to zero
- final job succeeded
- provenance chain verified
- canary user/data fully removed with zero residue

## Player Brief implementation status

Player Brief implementation is merged to `main`.

Current main at handoff time:

`e8961fb91c66d175ff07ca55a6a7dfef4b18d686`

Commit message:

`fix: keep canonical Player Brief compact`

Important merged work includes:

1. First-class versioned Player Brief tables and retrieval model.
2. Understanding delta contract and persistence.
3. Fresh AI contexts anchored to canonical Player Brief.
4. Materiality/quest/interrupt retrieval carrying Player Brief.
5. Context snapshots linked to exact Player Brief ID/version.
6. Delta idempotency and transition lineage.
7. Legacy compatibility bridge for mixed-version cutover.
8. Compact Player Brief hardening.

Key migrations / SQL files include:

- `supabase/sql/add_player_brief_memory.sql`
- `supabase/sql/bridge_legacy_understanding_to_player_brief.sql`
- `supabase/sql/compact_player_brief_payload.sql`

## Player Brief database behavior

New/important tables:

- `player_briefs`
- `player_brief_understanding_sources`
- `player_brief_signal_sources`
- `understanding_delta_batches`
- `understanding_transitions`

`context_snapshots` now carries `player_brief_id`.

`derived_understanding` has bounded `importance` and compactness constraints.

Understanding delta persistence validates:

- source knowledge provenance
- signal provenance
- recent quest-result provenance
- active quest provenance
- target understanding belongs to the current Player Brief
- target must be active
- stale Player Brief is rejected
- duplicate exact create is rejected
- update preserves type
- one target cannot be mutated twice in one delta

Resolve/supersede expires signals tied to the old understanding.

If delta action count is zero, current Player Brief is reused rather than creating a fake version.

## Compatibility bridge

Production DB currently includes a compatibility bridge for the legacy `persist_derived_understanding` RPC.

Reason: VPS runtime had not yet been updated to the latest Player Brief code at the time the DB schema was activated.

Bridge behavior:

- legacy understanding persistence remains functional
- candidate `importance` is preserved
- canonical Player Brief is refreshed exactly once after a legacy batch
- therefore Player Brief cannot silently go stale during the mixed-version window

Security was revalidated:

- anon execute: denied
- authenticated execute: denied
- service_role execute: allowed

The new delta RPC is also service-role-only.

## Production DB rollout / QA

Production migrations were applied only to `ispfhvdelglwvixaspza`.

Observed migration history entries included:

- `add_player_brief_memory`
- `bridge_legacy_understanding_to_player_brief`

The compact Player Brief hardening has also been applied/merged, and production state at latest verification was:

- Player Brief rows for Arkan: 2
- current Player Brief version: 2
- current reason: `compact_brief_hardening`
- current brief payload size: 12,430 bytes
- nonterminal inference jobs: 0
- pending knowledge: 0

Prior to compact hardening, migration backfill produced v1 from the existing player state.

Existing player data was preserved during rollout.

Earlier observed baseline counts around the rollout:

- knowledge entries: 1
- derived understanding: 15
- signals: 15
- Daily Quests: 4

Compact Player Brief keeps the current state bounded while granular details remain in `derived_understanding`.

## DB transactional QA already passed

Player Brief migration/state-machine tests were run in production Postgres inside transactions with rollback.

Observed PASS cases:

- initial Player Brief backfill
- no-op delta keeps same brief version
- create -> new brief version
- duplicate delta batch idempotently reuses persisted result
- update -> new version
- resolve -> new version
- supersede -> new version
- stale Player Brief rejected
- invalid update type rejected
- exact duplicate create rejected
- context snapshot linked to Player Brief
- service-role-only RPC privileges
- legacy bridge refreshes brief exactly once
- legacy bridge preserves importance
- cleanup/rollback leaves no fixture residue

## Build / regression status

Player Brief feature regression reached green build status.

Latest confirmed bridge build gate:

- 40 tests
- 40 PASS
- 0 FAIL
- TypeScript PASS
- Next.js production compile PASS
- static generation PASS
- Vercel preview READY

Compact Player Brief preview was also observed READY on branch commit:

`4b6d0cc46fc7879db7ee5b4c2177a524d994ee94`

That compact change is now merged into `main` as `e8961fb...`.

Vercel build-rate-limit has intermittently blocked additional deployments. Do not interpret those quota failures as code failures.

## Package-lock issue — still unresolved

Root `package-lock.json` remains stale relative to what `npm install --package-lock-only --ignore-scripts` generates.

Earlier clean `npm ci` failure showed missing/invalid optional WASM dependency chain, including:

- `@emnapi/core`
- `@emnapi/runtime`
- `@emnapi/wasi-threads`

A temporary repaired lock generated on VPS previously allowed `npm ci` and full build to proceed, proving the repair direction is valid, but that repaired lock was not successfully committed because the VPS did not have GitHub push credentials.

Do not hand-edit lockfile from guesses.

Attempts to generate/export the repaired lock through temporary Vercel branches were cleaned up and not merged because Vercel build-rate-limit blocked them.

At handoff time this remains repo hygiene, not a production runtime blocker.

## What is NOT finished yet

### 1. VPS runtime has not been cut over to latest `main`

The worker was previously confirmed on `7eec765...`, before the Player Brief delta implementation landed.

Production DB is safe during this mixed-version state because the compatibility bridge is live.

Still required:

- pull latest `main` to `/opt/superhuman`
- install worker deps if needed
- restart `superhuman-ai-worker.service`
- confirm service active
- confirm logs show latest worker using understanding-delta / Player Brief path

This requires actual VPS shell access. The current ChatGPT environment does not have direct SSH access; user execution is required unless a future SSH/VPS connector becomes available.

### 2. Real production Player Brief delta E2E after worker cutover

After worker latest is active, run an isolated/genuine activity cycle and verify:

`current Player Brief vN + new Life Vault batch -> fresh AI session -> understanding delta -> DB transitions -> Player Brief vN+1 (only if changed) -> one materiality decision -> quest stability / interrupt as appropriate`

Verify:

- exact input Player Brief ID/version recorded in context snapshot
- delta batch idempotency
- correct create/update/resolve/supersede transitions
- old signals expire when state is replaced/resolved
- no duplicate active understanding
- no Player Brief bump for no-op
- materiality uses the resulting current state
- no duplicated quests/interrupts
- backlog drains to zero

Use an isolated canary player if necessary and delete it fully afterward. Previous FK audit showed progression data cascades from the player root, but always re-check before destructive cleanup.

### 3. Root package-lock repair

Generate exact repaired `package-lock.json` with npm, verify clean `npm ci`, then commit only that file.

Do not run `npm audit fix --force` automatically.

## Suggested next-room execution order

1. Read this handoff.
2. Verify GitHub `main` is still at or ahead of `e8961fb...` and inspect any newer commits before acting.
3. Verify production Supabase Player Brief state and pending queue.
4. If VPS access is available through the user, atomically update/restart worker to latest `main`.
5. Verify worker logs and exact runtime commit.
6. Run real Player Brief delta E2E and inspect DB lineage/context snapshots.
7. Clean canary data if used.
8. Repair root `package-lock.json` from a real npm-generated lock and commit only the lockfile.
9. Final audit: GitHub clean, Supabase queue zero, current brief valid/bounded, Vercel healthy, worker current, no test artifacts.

## Engineering working rules from this room

- Assistant owns implementation end-to-end: inspect, design, code, test, commit, merge, rollout, verify.
- Do not stop after deployment smoke if meaningful engineering work remains.
- Ask the user only for genuinely unavailable boundaries such as VPS shell execution.
- Do not claim E2E PASS without observed evidence.
- Security/privacy first.
- Never touch wrong Supabase project.
- Do not make destructive production mutations without a rollback/cleanup plan and clear need.
- Prefer bounded context and deterministic persistence over growing chat history.
- Do not implement stealth/evasion/fingerprinting/rate-limit bypass behavior for the consumer browser integration.
- For provider throttling, use lower cadence, batching, backoff, cooldown, and circuit breaker only.

## Communication preferences relevant to this engineering project

- User prefers concise, practical, on-point updates.
- User expects the engineering room to deep-work until the scoped implementation is actually complete rather than repeatedly handing work back for minor decisions.
- User prefers minimal manual commands; use connectors/tools directly wherever possible.
- VPS commands may still need user execution because this ChatGPT environment has no direct SSH tool.

## One-line state for next room

Player Brief architecture is implemented, merged, migrated, compacted, and DB-safe; production currently has Arkan Player Brief v2 with zero pending queue. Remaining work is latest-worker VPS cutover, one observed real Player Brief delta E2E afterward, and exact npm-generated root `package-lock.json` repair.