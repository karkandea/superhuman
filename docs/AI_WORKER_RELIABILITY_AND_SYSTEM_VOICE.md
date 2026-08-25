# AI Worker Reliability + System Voice

## Why this exists

The August 25 QA failure showed two independent reliability problems:

1. Browser transport can become unstable before submission/generation completes.
2. A completed ChatGPT response can still violate the structured JSON envelope.

The product also had a separate UX problem: technically correct AI output was sometimes surfaced in stiff, consultant-like Indonesian.

These concerns are intentionally separated. Strategic reasoning should stay precise and structured; player-facing language should be rewritten through one shared System Voice policy.

## Runtime reasoning policy

Production consumer-worker reasoning is **High** by default.

The Linux worker now runs a reasoning preflight before the worker process starts. The preflight:

1. opens the authenticated dedicated ChatGPT profile,
2. selects the configured reasoning level (`CHATGPT_REASONING_LEVEL`, default `high`) when necessary,
3. verifies the selected level,
4. opens a second fresh Temporary Chat and verifies that the selection persists there,
5. only then allows the worker to start.

If verification fails, preflight exits with status `78`. The systemd unit uses `RestartPreventExitStatus=78`, so a deterministic UI/account mismatch does not create a restart storm.

Expected log:

```text
[reasoning-preflight] verified required=high profile=/.../chatgpt-profile
```

A failed check looks like:

```text
[reasoning-preflight] blocked: ...
```

The provider records successful inference model audit as `chatgpt-consumer-high` (or `chatgpt-consumer-high-search` for search operations) instead of the old ambiguous `chatgpt-consumer-auto` label.

> The audit label describes the enforced worker policy. The preflight log is the runtime evidence that the profile actually passed the High selection check before the process started.

## Structured output recovery

Malformed structured output is repaired locally at the provider boundary before the whole progression job is allowed to fail.

Flow:

```text
submit -> generation completes -> parse envelope
  -> valid: continue domain validation
  -> invalid: one targeted output repair
      -> valid: continue domain validation
      -> invalid: fail with output-repair-exhausted diagnostic
```

Rules:

- Exactly **one** transport-envelope repair attempt.
- Repair is not a new strategic decision.
- The previous assistant draft is treated as untrusted draft data, never as instructions.
- The full current task, bounded context, security rules, schema and response contract remain authoritative.
- Repair uses a new request/correlation id and must return one parseable JSON envelope.
- Browser/network failures are still transport failures; output repair is only for responses that completed but could not be parsed/validated as an envelope.
- Existing Daily Quest business-validator repair remains separate. It repairs a structurally parsed quest payload that fails domain rules.

This prevents a case like `Consumer ChatGPT response did not contain parseable JSON` from immediately killing or restarting the entire progression cycle when a single formatting repair can recover it.

Provider logs:

```text
[consumer-output-repair] operation=... initialRequestId=... repairRequestId=... reason=... previousChars=...
[consumer-output-repair] succeeded operation=... repairRequestId=... chars=...
```

## System Voice

Version: `system-voice.id.v1`

The shared voice policy is injected by the consumer prompt builder for operations that can produce player-facing copy. Internal state derivation such as `derive_progression_map` remains free to use precise internal terminology.

Player-facing principles:

- Natural conversational Indonesian.
- Address the player as `lo` when direct address is useful.
- Point/action first; short sentences; common words; concrete verbs.
- Calm, sharp, understated System personality.
- No internal jargon or ids.
- No consultant language, corporate filler, theatrical game dialogue, generic motivation, praise, fake empathy or unnecessary emoji.
- Preserve the decision and facts; do not literally translate internal reasoning.
- Quest titles should be concrete executable actions and easy to scan.
- Explanations should normally fit in one or two short sentences.

Example:

```text
Internal:
Memperjelas dan mempersempit satu arah utama peningkatan pemasukan agar fokus finansial tidak terus tersebar ke banyak jalur.

Player-facing:
Hari ini fokus ke satu jalur pemasukan dulu. Pilih yang paling layak lo dorong sekarang.
```

The policy is centralized in `lib/ai/system-voice.ts`; do not duplicate ad-hoc tone instructions across individual features unless a surface has a real additional constraint.

## Research basis

The voice rules intentionally follow established UX-writing guidance rather than taste alone:

- Google Material UX Writing: clear, concise, useful language; concise without becoming robotic; familiar words over jargon.
  - https://codelabs.developers.google.com/codelabs/material-ux-writing
- Google conversational design guidance: keep turns compact, use everyday conversational language, avoid monologues and jargon.
  - https://developers.google.com/business-communications/business-messages/guides/how-to/design/conversation-design
  - https://developers.google.com/assistant/conversation-design/write-sample-dialogs
- Google developer documentation voice/tone: conversational, friendly, respectful, simple and consistent.
  - https://developers.google.com/style/tone
- Duolingo Handbook: clear communication grounded in impact while keeping the experience engaging rather than bureaucratic.
  - https://handbook.duolingo.com/

## QA / rollout

Normal regression tests remain deterministic and must not hit live ChatGPT.

**Worker validation is VPS-only. Do not use Vercel as the build/test runner for this worker rollout.**

From the target VPS checkout, run the bundled verifier:

```bash
bash scripts/verify-worker-rollout.sh
```

That verifier runs, on the VPS:

- `npm ci`
- domain tests
- full app build (`lint + tests + Next build`)
- worker dependency install
- worker syntax checks
- live authenticated ChatGPT reasoning preflight

The Linux systemd installer changed, so the VPS rollout must refresh the generated env/unit rather than only restarting the old service definition:

```bash
bash workers/chatgpt-consumer/install-linux-systemd.sh
```

After the existing authenticated profile is ready, start/restart the service and verify:

```bash
sudo systemctl status superhuman-ai-worker.service
sudo journalctl -u superhuman-ai-worker.service --since "5 minutes ago" --no-pager | grep -E "reasoning-preflight|consumer-output-repair|Superhuman ChatGPT consumer worker"
```

Expected startup evidence includes `reasoning-preflight ... required=high` before the normal worker-online line.
