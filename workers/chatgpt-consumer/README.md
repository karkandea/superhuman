# ChatGPT Consumer Browser Worker

This worker lets Superhuman use an authenticated `chatgpt.com` consumer session as an `AiProvider` without an OpenAI API key.

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

The worker uses a dedicated Chrome profile directory, defaulting to:

`~/.superhuman/chatgpt-profile`

The directory is owner-only. Do not put it inside the repository, sync it to cloud storage, or copy cookies into environment variables.

The worker imports Superhuman domain code from the repository root. Install the main app dependencies once at repo root and the worker dependencies under this directory.

## macOS workstation runtime

For development or temporary production processing on a Mac:

```bash
bash workers/chatgpt-consumer/install-macos-launchagent.sh
```

The installer validates the Supabase backend key, opens a dedicated normal Chrome profile for one-time ChatGPT login, verifies that session over local CDP, and installs a LaunchAgent.

This runtime is not independently 24/7: processing stops when the Mac is powered off, asleep, offline, or loses the ChatGPT session.

## Linux VPS 24/7 runtime

Target runtime: Debian/Ubuntu Linux with systemd, a non-root SSH user with sudo, Node.js 20+, and an x86_64 host for automatic Google Chrome installation.

From a Superhuman checkout on the VPS:

```bash
bash workers/chatgpt-consumer/install-linux-systemd.sh
```

The installer:

- validates the backend key against the canonical Superhuman Supabase project
- installs the virtual-display/noVNC dependencies when needed
- installs Google Chrome on supported x86_64 Debian/Ubuntu hosts when missing
- stores secrets in `~/.config/superhuman/consumer-worker.env` with mode 600
- stores the dedicated browser profile in `~/.superhuman/chatgpt-profile`
- installs `superhuman-ai-worker.service` with automatic restart
- intentionally leaves the service stopped until ChatGPT login is verified

Then run the one-time VPS login helper:

```bash
bash workers/chatgpt-consumer/login-linux-novnc.sh
```

The helper starts Chrome in an Xvfb virtual display and exposes noVNC only on VPS localhost. From the operator Mac, create an SSH tunnel exactly as printed by the helper, then open the local noVNC URL and log into ChatGPT normally.

After the normal composer is visible, return to the VPS terminal and press Enter. The helper performs two checks:

1. verifies the live visual Chrome session over local CDP
2. closes the temporary visual stack and verifies the same saved profile headlessly

Only after both checks pass does it enable and start `superhuman-ai-worker.service`.

Service operations:

```bash
sudo systemctl status superhuman-ai-worker.service
sudo journalctl -u superhuman-ai-worker.service -f
sudo systemctl restart superhuman-ai-worker.service
```

If ChatGPT later expires or the worker reports `blocked_auth`, rerun `login-linux-novnc.sh`. The systemd service itself is designed to survive SSH disconnects, worker crashes, and VPS reboots.

## Normal worker invocation

For manual debugging:

```bash
SUPABASE_URL=... \
SUPABASE_SECRET_KEY=... \
CHATGPT_HEADLESS=true \
npm start
```

Use an OS/service secret manager or the installer-owned env file for `SUPABASE_SECRET_KEY`; never commit it or prefix it with `NEXT_PUBLIC_`.

## Failure behavior

- expired/not-authenticated ChatGPT session -> job becomes `blocked_auth`
- browser challenge/loading/timeout -> retry with lease + backoff
- malformed/correlation-mismatched model output -> retry; nothing is persisted
- insufficient player knowledge/signals -> no random quest is generated
- exhausted retry budget -> `failed`
- duplicate generation -> existing `(user_id, quest_date)` quest batch is returned; no duplicate quest batch is created
- worker crash -> lease expiry makes the job claimable again

The production queue is shared across players. A single worker can process jobs for multiple users sequentially; scale-out can add more workers later because claiming uses database leases rather than player-specific local state.
