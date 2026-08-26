# Worker QA Harness

Worker Lab QA runs the real ChatGPT consumer browser stack without using a Superhuman player account or the production `ai_inference_jobs` queue.

## Control plane

The harness is operated through service-role-only Supabase RPCs.

Create a run:

```sql
select public.request_worker_qa_run('progression_target_normal', 20) as qa_run_id;
```

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

The QA claim RPC also yields while runnable production AI jobs exist so Worker Lab does not compete for machine/provider capacity when production work is waiting.

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

Recommended reliability loop:

1. Trigger the same scenario/fixture for 10-20 repetitions.
2. Wait until the run is terminal.
3. Compare technical success rate, failure distribution, recovery usage, p95 latency and output quality.
4. After a worker patch, rerun the exact scenario and fixture version.
5. Use production-account E2E only after Worker Lab is green.

A green Worker Lab result is evidence about browser/consumer-worker reliability. It does not replace final product E2E validation.
