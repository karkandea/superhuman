# Progression Intelligence Architecture

Status: core product contract.

## Four distinct state layers

### Player Brief
Canonical compact/current understanding of who the player is: durable goals, priorities, constraints, preferences, relationships, and current life direction. It is not a daily schedule and not raw Life Vault.

### Progression Map
Versioned strategic state describing what the player is trying to move and the current causal hypothesis:

`Distal Goal -> Proximal Outcome -> Bottleneck / Opportunity`

It is not a task list. Nodes must be evidence-backed by current player signals. Uncertainty is stored explicitly instead of being converted into invented causal certainty.

### Daily Context
Date-bounded temporary state for the current day: capacity, unusual schedule, health, travel, location, appointments, and other temporary constraints. One-off Daily Context must not become permanent Player Brief/Progression Map evidence by itself.

### Player Response Model
Versioned behavioral state describing what intervention patterns appear to work for this player, based on actual quest exposures and responses. It may represent execution patterns, dose/difficulty calibration, receptivity/context patterns, strategy evidence, and uncertainty. It must not become an identity label.

## Daily decision pipeline

1. Process new Life Vault evidence into canonical understanding.
2. Synchronize Quest Response events from real quest outcomes.
3. Review response evidence while separating compliance from effectiveness.
4. Refresh the Player Response Model when evidence changed.
5. Refresh the Progression Map from current signals and learned response evidence.
6. If the day has no finalized plan, use Daily Context to choose one Today Progression Target.
7. Generate 8–15 candidate actions against that target.
8. Apply the feasibility/receptivity gate before selection.
9. Score feasible candidates with the eight Quest Policy dimensions.
10. Select a bounded quest portfolio, or explicitly select no quest.
11. Persist causal chain and executable contract with each selected quest.

A finalized plan is immutable by default for that date. Learning after execution updates strategic state for future decisions but does not silently reroll the current plan. Mid-day material evidence continues through Materiality -> no change / suggestion / explicit System Interrupt.

## Causal quest contract

Every newly generated strategic quest carries:

- `strategic_chain`
  - distal goal id
  - proximal outcome id
  - driver type: bottleneck / opportunity / maintenance
  - driver id when relevant
  - concise causal reason
- `execution_contract`
  - concrete action
  - observable completion condition
  - appropriate context
  - bounded dose

The player UI may show a compact `WHY`, `DONE WHEN`, and `DOSE`. Internal scores remain audit data, not UI burden.

## Quest Policy V2

Hard principles:

- quest must connect to a real player objective or justified maintenance intent;
- strategy comes before task generation;
- feasibility/receptivity is checked before selection;
- use existing eight scoring dimensions consistently, but do not replace judgment with one blind weighted sum;
- exactly one Main Quest when any quest is selected;
- max two Side, one Maintenance, one Bonus, and never exceed the day target ceiling;
- no filler;
- zero quests is a valid intelligent portfolio;
- respect uncertainty;
- stable by default;
- do not destroy completed history;
- temporary Daily Context is not permanent memory.

## Response learning

Quest result captures compliance:

- completed
- partial
- skipped
- failed
- optional natural-language note

A Quest Response event additionally stores the quest strategic chain, execution contract/dose, and the Daily Context under which it was given.

The reasoning layer may infer a barrier hypothesis, but must not turn failure into a character judgment. Plausible hypotheses include oversized dose, timing/receptivity mismatch, ambiguous completion criteria, temporary capacity, or an upstream blocker.

### Compliance is not effectiveness

`completed` means the player executed the action. It does not prove that the proximal outcome moved.

Effectiveness starts as `unknown`. A non-unknown effectiveness rating requires downstream evidence from current player signals and must cite those signal IDs. This prevents repeated busywork from being mistaken for progression.

## Adaptive difficulty / dose

There is no universal target success rate and no hardcoded challenge-skill ratio. Calibration is learned from the player’s own response history. Repeated easy execution may justify a modest increase. Repeated partial/skipped/failed execution may justify a smaller dose, simpler action, better context, or a different upstream strategy.

## No-quest decision

The System may finalize a day with zero quests when:

- worthwhile candidates are not feasible/receptive today;
- important progress is already sufficiently covered;
- another intervention would mainly add burden;
- uncertainty is too high to justify action;
- recovery/maintenance without an additional task is the higher-value choice.

No-quest is persisted as a generated daily plan with an explicit reason. It is not an empty-result error.

## Future statistical personalization

The current architecture deliberately remains evidence-backed AI reasoning plus deterministic contracts. It does not implement reinforcement learning or a contextual bandit. The persisted response data can support future statistical personalization once volume, observability, and evaluation quality are sufficient.
