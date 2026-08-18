# Auth + Ownership Rollout

## Production status — 2026-08-18

Target project was explicitly re-confirmed before every production operation:

- Supabase project: `superhuman`
- project ref: `ispfhvdelglwvixaspza`
- region: `ap-northeast-2`

The legacy player set is now intentionally one player:

| Player | Canonical UUID | Auth email | Status |
| --- | --- | --- | --- |
| Arkan | `f26ca205-54f6-43ce-9fa7-417b747faabe` | `karkandea@gmail.com` | linked to Supabase Auth |

Ais (`5d93e7e4-fcb2-479d-bab2-a8c7924c5e8d`) was explicitly removed from production by product decision. Preflight showed only 1 `daily_logs` row and 4 `time_slots` rows; all relevant legacy ownership FKs use `ON DELETE CASCADE`, so those rows were removed with the player. No checklist items, weekly goals, or weekly progress belonged to Ais.

## Ownership model

The existing player UUID remains the canonical owner ID. Arkan's Supabase Auth identity uses the exact same UUID as `public.users.id`, so existing checklist/history foreign keys required no ID rewrite or data-copy migration.

Authorization is based on `auth.uid()`, never user-editable metadata or the human-readable username route.

## Applied migrations

Production migration history now includes:

- `20260818051516 enforce_auth_ownership`
- `20260818051723 create_player_knowledge_foundation`
- `20260818051756 add_progression_persistence`
- `index_progression_foreign_keys` was subsequently applied after Performance Advisor identified uncovered composite FKs.

The repository keeps reviewed SQL under `supabase/sql/`; Supabase MCP `apply_migration` was used for production DDL.

## Auth provisioning note

The preferred path remains `scripts/create-auth-user.mjs`, which calls the supported `auth.admin.createUser` API with the existing UUID. In this execution environment the Supabase connector did not expose Auth Admin actions and no service-role secret was available to run the script.

Arkan was therefore bootstrapped once, transactionally, directly into the managed Auth user + email identity tables after verifying the current schema. The first attempt referenced a generated `confirmed_at` column and failed with a full transaction rollback; the corrected attempt omitted generated fields and created exactly one confirmed email identity. Post-checks verified:

- `auth.users.id = public.users.id`
- email = `karkandea@gmail.com`
- email confirmed
- provider = `email`
- provider id = canonical player UUID

Do not use direct Auth-table bootstrap for normal future user provisioning. Future players should be created through Supabase Auth Admin APIs.

## Legacy RLS verification

After `enforce_auth_ownership`:

- public players: 1
- Auth users: 1
- linked players: 1
- `users_auth_user_fkey`: present
- all 6 legacy tables have RLS enabled
- anon policies: 0
- anon table grants on legacy tables: 0
- owner claim can read Arkan's existing data
- deleted/non-owner UUID claim sees 0 Arkan profile/checklist/log rows
- anon `SELECT public.users` fails with PostgreSQL `42501 permission denied`

Existing Arkan data remained visible under the owner claim: 26 checklist items, 13 daily logs, 4 time slots, 4 weekly goals, and 4 weekly-progress rows at verification time.

## Life Vault / progression verification

The secure Player Knowledge and progression migrations were applied only after the legacy Auth/RLS gate passed.

Transactional production QA (fully rolled back) verified:

1. authenticated Arkan can ingest a manual natural-language life update;
2. the owner can read the inserted raw knowledge;
3. a non-owner claim sees 0 rows;
4. raw knowledge can produce a derived understanding with mandatory raw-source provenance;
5. derived understanding produces a normalized player signal;
6. a Daily Quest must cite a signal from the persisted bounded context;
7. understanding-to-knowledge and quest-to-signal provenance rows exist;
8. a duplicate generation call for the same player/date keeps exactly one quest batch and one quest and returns the persisted quest payload;
9. all QA data was rolled back.

## Login behavior

The root app uses email magic links with `shouldCreateUser: false`. Unknown emails cannot create players. After authentication, the app resolves `public.users.id = auth.users.id` and routes only to that player.

All `[username]` routes are also wrapped in an application-level Auth ownership guard. The username is display/routing state, not an authorization boundary; RLS remains authoritative.

A minimal Auth hotfix was pushed to `main` after the DB lockdown so the production frontend does not continue using the incompatible anonymous username-picker flow while PR #1 remains draft.

## Advisor status

Security Advisor after rollout reports only `auth_leaked_password_protection` disabled. The application uses passwordless magic-link authentication, so there is no password credential in this current flow; enable leaked-password protection before introducing password auth.

Performance Advisor initially flagged uncovered composite provenance/ownership FKs. `index_progression_foreign_keys` added covering indexes; the remaining notices are only `unused_index` INFO notices expected for brand-new, mostly empty tables.

## Safety / rollback

Prefer roll-forward. `users_auth_user_fkey` uses `ON DELETE RESTRICT`, preventing accidental deletion of the Auth identity while the player row exists.

Never silently restore broad anon policies. Doing so would reopen all legacy player data. If Auth routing breaks, diagnose session/redirect configuration first.

Production QA mutations should continue to use transactions + rollback wherever possible, especially for Life Vault, understanding, signals, and quest generation.
