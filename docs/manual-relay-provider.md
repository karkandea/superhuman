# Manual Relay Provider

Manual Relay keeps the Superhuman progression core intact while replacing automated consumer-ChatGPT browser inference with a human-operated relay.

## Runtime flow

1. Player activity creates/requeues the existing `ai_inference_jobs` progression job.
2. `manual-worker.mjs` claims the job and runs the same progression orchestration as the browser worker.
3. When the core calls `AiProvider.invokeStructured`, `ManualRelayProvider` creates a durable `manual_inference_turns` row containing the existing structured ChatGPT prompt.
4. The job is moved to `waiting_operator`. The active durable progression step is intentionally left open rather than marked failed.
5. Operator opens `/operator/inference`, copies the prompt into ChatGPT, pastes the full response, and clicks **Submit & Continue**.
6. The response is stored, the job is returned to `queued`, and the manual worker resumes it.
7. `ManualRelayProvider` validates the same envelope used by `ChatGptConsumerWebProvider`, returns a normal `AiProviderResponse`, and the core continues unchanged.
8. If another model call is needed, another operator turn is created. When the progression run completes, Player Model / quest / evidence / transcript persistence follows the existing path.

The legacy `worker-v2.mjs`, Playwright transport, browser profile, QA harness, and browser-related migrations remain in the repository unchanged.

## Database migration

Apply:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/sql/add_manual_relay_provider.sql
```

The migration adds:

- `manual_inference_turns`
- `ai_inference_jobs.status = waiting_operator`
- `ai_inference_attempts.status = waiting_operator`
- `pause_ai_inference_job_for_operator(...)`
- `resume_ai_inference_job_from_operator(...)`

Manual waits do not consume the normal inference retry budget. Resume compensates for the claim counter before the next claim.

## Web operator credentials

`/operator/inference` is not backed by the public Supabase client. Its API requires both the server Supabase secret key and a separate operator token.

Add these to `/etc/superhuman-web.env` on the VPS:

```bash
SUPABASE_URL=https://<superhuman-project>.supabase.co
SUPABASE_SECRET_KEY=<server-only-secret-key>
SUPERHUMAN_OPERATOR_TOKEN=<long-random-operator-token>
```

`ops/vps-web/deploy.sh` copies these into the standalone server runtime `.runtime.env` with mode `0600`. They are never exposed through `NEXT_PUBLIC_*` variables.

Generate a token, for example:

```bash
openssl rand -hex 32
```

The operator enters this token in the console. The browser keeps it in `sessionStorage` for the current tab/session.

## Worker cutover

Do not delete the browser worker service or browser profile. Stop it, then run the manual worker using the same Supabase worker environment.

From `workers/chatgpt-consumer`:

```bash
npm run start:manual
```

One-shot diagnostics:

```bash
npm run once:manual
```

For production systemd, point the active inference service at `npm run start:manual` while preserving the old unit/config so rollback is a one-line ExecStart/service reversal.

Important: never run the browser worker and manual worker against the same production inference queue at the same time. Both use the same claim RPC and would race for jobs.

## Operator console

Open:

```text
https://<superhuman-host>/operator/inference
```

For each pending turn:

1. Copy **Prompt to ChatGPT**.
2. If the console shows **WEB SEARCH REQUIRED**, run the prompt in ChatGPT with web search available.
3. Copy the complete ChatGPT response.
4. Paste it into **Paste ChatGPT Response**.
5. Optionally set a model label.
6. Click **Submit & Continue**.

The provider validates `requestId`, `operation`, and `schemaVersion` using the existing consumer envelope parser. A malformed/correlation-mismatched response returns the same turn to the operator as `invalid` with the parser error displayed.

## Rollback

The migration is additive and the legacy browser runtime remains available. To roll back inference execution:

1. Stop the manual worker.
2. Start the previous browser worker service/command.
3. Leave `manual_inference_turns` in place; it is isolated from the browser provider and can be retained for audit history.

No Player Model, quest, evidence, conversation, or progression-core schema needs to change for rollback.
