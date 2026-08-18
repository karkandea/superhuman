# Production Rollout Verification — 2026-08-18

Target Supabase project: `superhuman` (`ispfhvdelglwvixaspza`).

## Identity

- Arkan remains canonical player `f26ca205-54f6-43ce-9fa7-417b747faabe`.
- Auth email: `karkandea@gmail.com`.
- Supabase Auth uses the same UUID as `public.users.id`.
- Ais (`5d93e7e4-fcb2-479d-bab2-a8c7924c5e8d`) was removed by explicit product decision together with its cascading 1 daily log and 4 time slots. It had no checklist items, weekly goals, or weekly progress.

## Applied Supabase migrations

- `20260818051516 enforce_auth_ownership`
- `20260818051723 create_player_knowledge_foundation`
- `20260818051756 add_progression_persistence`
- `20260818051949 index_progression_foreign_keys`

## Security verification

Final audit:

- public players: 1
- Auth users: 1
- anon policies across legacy + progression sensitive tables: 0
- anon table grants across those tables: 0
- RLS-disabled sensitive tables: 0
- non-owner claim sees no Arkan profile/checklist/daily-log rows
- unauthenticated legacy table read returns PostgreSQL `42501 permission denied`

Owner-claim legacy regression verified the existing Arkan rows remained readable: 26 checklist items, 13 daily logs, 4 time slots, 4 weekly goals, and 4 weekly-progress rows at verification time.

## Life Vault / progression verification

Production schema now contains secure raw knowledge, derived understanding, player signals, bounded context snapshots, persistent quest batches, Daily Quests, quest provenance, and quest results.

Transactional QA was executed against the real production schema and rolled back completely. It verified:

- authenticated manual life-update ingestion
- owner visibility
- non-owner isolation
- raw knowledge -> derived understanding provenance
- derived understanding -> signal persistence
- signal-backed Daily Quest persistence
- quest -> signal provenance
- exactly one batch and one quest for repeated same-player/same-date generation
- repeat generation returns the persisted quest payload

Final permanent progression data row counts were all zero after rollback, so no QA fixture remains in the user's Life Vault.

## Production frontend

A minimal Auth compatibility hotfix was pushed to `main` after the database lockdown instead of merging the large draft progression PR.

Main commits:

- `84e9180d6b97a129ccc4719c3ebc5c40499aafbb` — require Auth on player routes
- `458809e95cc7ca9096119935c1b404fd59db3ff6` — replace username picker with magic-link login
- `58edf22eb70552bda34fa9b2ff913b5da13bb2fa` — support publishable/legacy public Supabase key configuration

Production Vercel deployment `dpl_BZyCa33T3Djy51JvLaqBHv5sQeWG` is READY. Build passed Next.js compile, TypeScript, and static generation. `https://superhuman.dualangka.com` responds 200 and serves the new Auth bootstrap UI (`AUTHENTICATING SYSTEM...`).

## Remaining verification limitation

A real email magic-link click-through session has not been completed by automation. The available Supabase connector does not expose Auth Admin/send-link actions, the runtime cannot perform the Auth HTTP POST, and no interactive browser tool is available in this execution environment. Auth identity, owner JWT/RLS behavior, and production UI contract are verified; inbox delivery + click-through remains the only Auth E2E step not independently observed.

## Advisors

Supabase Security Advisor only reports leaked-password protection disabled. Current authentication is passwordless magic-link, so this does not weaken the current passwordless credential path; enable it before adding password authentication.

Performance Advisor no longer reports unindexed foreign keys after `index_progression_foreign_keys`. Remaining notices are only unused-index INFO entries expected for newly created, empty tables.
