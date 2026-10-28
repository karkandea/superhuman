# Superhuman — AI Personal Progression System

An experimental personal-progression application that turns player-provided context into an auditable daily quest system. It explores how long-lived goals, evidence-backed understanding, and explicit revision rules can work together without reshuffling a user's plan on every refresh.

> **Status:** Research-heavy product engineering project. Some operations depend on a separately configured browser/worker transport. This is not an official OpenAI integration, a general-purpose hosted AI API, or a claim of unattended production reliability.

## Core product loop

```text
Player knowledge → derived understanding → signals
       → bounded retrieval → daily quests → outcomes
                               ↘ materiality review → explicit revision
```

**Stable by default:** a player's daily quest batch is persisted for a given day. New knowledge updates understanding, but changes an existing plan only when a materiality assessment justifies it.

## Engineering highlights

| Area | Implementation |
| --- | --- |
| Web | Next.js 16 App Router, React 19, TypeScript |
| Identity | Supabase Auth; ownership aligned to authenticated user IDs |
| Persistence | Postgres/Supabase tables, RLS policies, SQL migrations |
| Reasoning boundary | Provider abstraction, bounded context retrieval, strict operation/schema validation |
| Reliability | Persisted workflow state, correlated requests, retry/recovery and checkpoint logic |
| Traceability | Knowledge and signal provenance, context snapshots, quest revisions and results |
| Testing | Deterministic fake-provider tests; live-model checks separated from routine tests |

## Project map

- [`app`](app) — player routes, authentication screens and operator surfaces.
- [`lib`](lib) — progression domain, orchestration, retrieval, policies and AI-provider boundary.
- [`supabase/sql`](supabase/sql) — SQL migrations and persistence policies.
- [`workers`](workers) and [`ops`](ops) — separate reasoning transport and operational tooling.
- [`tests`](tests) — domain, contract, recovery and worker-regression tests.

## Local setup

Requirements: a Node.js version supported by Next.js 16, npm, and a dedicated Supabase development project with the required schema/policies. Do not connect development or synthetic tests to live user data.

```bash
npm ci
# Configure NEXT_PUBLIC_SUPABASE_URL and a public Supabase publishable/anon key
# in a private .env.local; never place service-role credentials in NEXT_PUBLIC_*.
npm run dev
```

The web app requires the appropriate database schema and RLS setup. AI-backed operations additionally need separately provisioned worker/provider infrastructure; `npm run dev` alone does not create a working production reasoning service. Follow the architecture and rollout documentation before operating the full stack.

## Safe verification

```bash
npm run lint
npm test
npm run build
```

`npm test` uses deterministic fake-provider fixtures and a guard against accidental live ChatGPT calls. Live-model smoke checks are exceptional and must be separately authorized, bounded and non-sensitive.

## Design documentation

- [System architecture and data ownership](docs/system-architecture.md)
- [Quest stability and revision policy](docs/QUEST_POLICY.md)
- [Progression intelligence](docs/PROGRESSION_INTELLIGENCE.md)
- [AI testing policy](docs/ai-testing.md)
- [Worker reliability and system voice](docs/AI_WORKER_RELIABILITY_AND_SYSTEM_VOICE.md)

## Boundaries and review notes

- Supabase RLS and service-role restrictions are critical security boundaries, not optional local conveniences.
- The provider interface is transport-agnostic in the domain; the configured consumer-browser worker is experimental and should not be mistaken for a supported first-party API.
- Automated tests cover contracts and recovery paths; real user sign-in, transport operation, and production deployment still require environment-specific checks.
- Historical operational documents may include internal deployment or personal-context details. **Review and sanitize those documents before treating this repository as a polished public portfolio artifact.**

This repository demonstrates **stateful AI orchestration, provenance, failure recovery, and privacy-aware data ownership**, with the above operational limits explicitly acknowledged.
