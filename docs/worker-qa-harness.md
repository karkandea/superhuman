# Worker QA Harness

Worker Lab QA runs the real ChatGPT consumer browser stack without using a Superhuman player account or the production `ai_inference_jobs` queue.

## Control plane

The harness is operated through service-role-only Supabase RPCs.

Create a live canary run:

```sql
select public.request_worker_qa_run('progression_target_normal', 1) as qa_run_id;
```

Live runs are intentionally capped at **1-2 repetitions**. Worker Lab is an integration canary, not a load-test target for the shared ChatGPT account.

Supported scenarios:

- `progression_target_normal`
- `quest_generation_normal`
- `search`
- `composer_recovery`
- `full_chain_normal`

Read the complete run, iterations, step outputs and checkpoints:

```sql
select public.get_worker_qa_run('<qa_run_id>'::uuid);
```

Cancel queued work:

```sql
select public.cancel_worker_qa_run('<qa_run_id>'::uuid);
```

No authenticated/player RPC grants exist. QA is an operator surface only.

## Runtime isolation

The QA worker runs as `superhuman-ai-qa-worker.service` and uses:

- real `ChatGptConsumerWebProvider`
- real `PlaywrightChatGptTransport`
- reasoning level `high`
- isolated Chrome profile `/var/lib/superhuman-ai/chatgpt-qa-profile`
- isolated CDP `http://127.0.0.1:9223`

The QA profile is bootstrapped once from the authenticated production Chrome profile while the production browser is briefly stopped, then operates independently.

Browser-profile isolation does **not** imply provider-quota isolation. Production and QA are treated as consumers of one shared ChatGPT account resource.

## Shared traffic controller

All real consumer calls, including output-repair calls, pass through one Supabase-backed traffic controller.

The controller enforces:

- one in-flight ChatGPT request across production + QA
- production priority before any new QA request
- global circuit breaker after provider rate-limit signals
- a longer QA-specific cooldown after provider rate limits
- adaptive QA pacing using `qa_next_allowed_at`
- shared `last_success_at`, `last_rate_limit_at`, `cooldown_until`, and `rate_limit_streak`

A QA claim also yields before starting an iteration while production work, provider cooldown, QA cooldown, pacing, or another active traffic lease exists.

## Evidence

Each run stores:

- scenario and fixture version
- worker Git release SHA
- repetition count
- technical success/failure counts
- validator failure count
- recovery count
- average and p95 iteration latency
- error distribution

Each iteration stores:

- duration
- worker/release
- output
- exact terminal error code/message
- validator result
- recovery count
- browser checkpoints

Each step additionally stores:

- step name and operation
- request id
- output
- validator errors
- recovery count
- browser checkpoint timeline

## QA loop

Recommended loop:

1. Run ordinary mock/fixture regression coverage for state-machine and contract changes.
2. Trigger **one live canary** for the affected real browser/provider path.
3. If the canary is clean, optionally run one second live canary after the shared pacing window.
4. If provider rate-limit protection appears, stop live QA; let the shared circuit breaker cool the account instead of retrying aggressively.
5. After a worker patch, repeat the same mock/fixture coverage and 1-2 live canaries.
6. Use production-account product E2E only after Worker Lab is green.

A green Worker Lab canary is evidence that the real browser/provider integration still works. Reliability confidence for state-machine behavior comes primarily from deterministic mock/fixture regression coverage, not high-frequency live ChatGPT repetition.
