# Auth + Ownership Rollout

## Why this comes before Life Vault

The current production schema uses `public.users.id` as the owner key for checklist items, daily logs, time slots, weekly goals, and weekly progress. RLS is enabled, but the existing policies grant broad access to the `anon` role. That is not safe enough for private Player Knowledge.

## Ownership model

Keep the existing player UUID as the canonical owner ID.

For each legacy row in `public.users`, create the corresponding Supabase Auth user with the **same UUID**. This preserves every existing foreign key and all historical data while allowing RLS to use the direct predicate `(select auth.uid()) = user_id`.

Do not put authorization decisions in user-editable `user_metadata`.

## Rollout order

1. Keep PR #1 in draft while auth is being introduced.
2. Create one Supabase Auth account per existing player with `scripts/create-auth-user.mjs`. The script requires a server-only secret/service-role key and explicitly reuses the existing player UUID.
3. Configure the Supabase Auth Site URL / redirect URLs for the deployed app.
4. Promote `supabase/sql/enforce_auth_ownership.sql` into a real timestamped migration using `supabase migration new`.
5. Apply the migration. Its first block aborts if any legacy player is still missing a same-ID Auth account.
6. Run Supabase security advisors and verify anon requests cannot read `users`, `checklist_items`, or `daily_logs`.
7. Validate magic-link login, daily quest read/write, history read, and cross-player denial.
8. Only after this passes should Life Vault / Player Knowledge tables be introduced.

## Provisioning command

```bash
SUPABASE_URL=... \
SUPABASE_SECRET_KEY=... \
node scripts/create-auth-user.mjs <existing-player-uuid> <player-email>
```

`SUPABASE_SERVICE_ROLE_KEY` is accepted as a legacy fallback. Never prefix either admin key with `NEXT_PUBLIC_`.

## Login behavior

The root screen uses email magic links with `shouldCreateUser: false`. Unknown emails are not auto-created. After authentication, the app resolves `public.users.id = auth.users.id` and routes only to that player's username page.

The existing `[username]` routes can remain readable by name because RLS makes every other player's `users` row invisible to the authenticated session.
