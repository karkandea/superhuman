# ChatGPT Consumer Browser Worker

This worker lets Superhuman use the player's authenticated `chatgpt.com` consumer session as an `AiProvider` without an OpenAI API key.

## Trust boundary

- The Next.js app never receives ChatGPT cookies or credentials.
- Supabase remains the canonical source of truth.
- The worker claims only queued jobs and retrieves bounded context through the existing Superhuman context retriever.
- Raw Life Vault text is sent only when the job is deriving understanding from explicitly selected pending entries.
- Daily Quest generation uses derived signals + recent quest results, not the full raw Vault.
- Browser responses must include the exact correlation ID, operation, and schema version before domain validation can run.
- Persistence occurs only after existing Superhuman validators accept the payload.
- ChatGPT conversation references are stored only as audit references on the inference job; the conversation is not player memory.

## Session handling

The worker uses a dedicated Chromium profile directory, defaulting to:

`~/.superhuman/chatgpt-profile`

The directory is created with owner-only permissions. Do not put it inside the repository, sync it to cloud storage, or copy cookies into environment variables.

One-time setup:

```bash
cd workers/chatgpt-consumer
npm install
npm run install-browser
SUPABASE_URL=... SUPABASE_SECRET_KEY=... npm run login
```

Complete ChatGPT login in the opened browser once. After the composer is detected, the process exits and normal inference can run headlessly.

Normal worker:

```bash
SUPABASE_URL=... \
SUPABASE_SECRET_KEY=... \
CHATGPT_HEADLESS=true \
npm start
```

Use an OS/service secret manager for `SUPABASE_SECRET_KEY`; never commit it or prefix it with `NEXT_PUBLIC_`.

## Failure behavior

- expired/not-authenticated ChatGPT session -> job becomes `blocked_auth`
- browser challenge/loading/timeout -> retry with lease + backoff
- malformed/correlation-mismatched model output -> retry; nothing is persisted
- exhausted retry budget -> `failed`
- duplicate generation -> existing `(user_id, quest_date)` quest batch is returned; no duplicate quest batch is created
- worker crash -> lease expiry makes the job claimable again

Run `npm run login` again after a `blocked_auth` status, then press `GENERATE TODAY'S QUEST` again. Normal generation itself requires no ChatGPT UI interaction.
