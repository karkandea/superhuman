# Quest Policy / Quest Constitution

Status: product + implementation contract for Daily Quest generation.

## Decision target

The System is not trying to represent every player goal in a checklist. It chooses the small set of actions that most deserve the player's attention today.

The core question is:

> From everything this player could do today, what small set of executable actions most increases the chance that life moves in the direction the player wants, given the real conditions of this day?

## Three layers

### Player Brief

Canonical permanent/current player state: goals, priorities, obstacles, opportunities, preferences, relationships, longer-term constraints, and current life direction.

### Daily Context

Temporary state for one local calendar date only. It fills observability gaps such as unusual schedule, appointments, travel, temporary health/energy, location, family commitments, or reduced capacity.

Daily Context is **not** Life Vault evidence and must not automatically become permanent player understanding.

Examples:

- “Today I am in meetings 09:00–17:00.” → Daily Context only.
- “Starting next month every Monday is a full meeting day.” → longer-term evidence belongs in Life Vault and may update Player Brief through the normal understanding pipeline.

Daily Context is locked once the first Daily Quest batch exists. Later changes go through Update System → Life Vault → Understanding Delta → Materiality → no change / suggestion / explicit System Interrupt.

### Quest Engine

Inputs:

- current Player Brief
- active evidence-backed signals/goals
- recent quest outcomes and execution history
- Daily Context for the target date

The engine applies this Quest Policy before persisting the first quest batch.

## Candidate-first decision process

The AI must not jump directly to final quests.

1. Generate **8–15** distinct, evidence-backed candidate actions.
2. Score every candidate 0–5 on the same dimensions:
   - goal relevance
   - urgency
   - leverage / impact
   - obstacle removal
   - actionability today
   - Daily Context fit
   - progression value
   - redundancy penalty
3. Select a **portfolio**, not blind top-N scores.

The dimensions are a consistent reasoning frame, not a hardcoded weighted formula. Product invariants are validated in code.

## Portfolio invariants

Initial Daily Quest contains **1–5** quests:

- exactly **1 Main Quest**
- at most **2 Side Quests**
- at most **1 Maintenance Quest**
- at most **1 Bonus Quest**

A single focused Main Quest is valid when capacity is very low or one action deserves concentrated attention. Never invent filler to occupy a slot. Not every life domain needs representation every day.

Priority uses **5 = highest** and **1 = lowest**.

## Adaptive difficulty

Recent quest results are calibration data.

- Repeated success may justify a modest increase in difficulty, duration, or realism.
- Repeated partial/skipped/failed outcomes should cause the System to simplify, shrink, reschedule, or identify the actual blocker instead of repeating an oversized quest.
- Failure is data, not punishment.
- When a bottleneck is visible, prefer removing the bottleneck over adding more activity in an area already progressing well.

The goal is a small stretch beyond current comfort without ignoring real capacity.

## Stability after generation

The first Daily Quest batch is generated once and remains stable by default.

Refreshing/opening the app does not reroll quests.

After the plan exists:

Life Vault update → Understanding Delta → Materiality Assessment →

- no change
- suggestion
- explicit System Interrupt

A material update never silently regenerates the whole day.

## UX contract

On the first open of a day with no persisted quest:

**SYSTEM CHECK-IN**  
Anything today that should affect your quests?

- **No, normal day**
- **Tell System…**

Natural language is enough. There is no schedule/category/energy form.

After check-in, the System generates the first quest portfolio. Once quests exist, the normal Today experience returns and Update System becomes the input for new evidence throughout the day.

## Non-goals

- Daily Context is not a second Player Brief.
- Daily Context is not automatically written into Life Vault.
- Quest generation does not scan the full raw Life Vault.
- Quest Policy is not a static mathematical ranking formula.
- Quests do not mirror every goal or life category.
- Refresh does not regenerate quests.
- Mid-day changes do not bypass Materiality / System Interrupt.
