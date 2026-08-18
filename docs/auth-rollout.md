# Auth + Ownership Rollout

## Status

Production hardening is **prepared but blocked** until both legacy player emails are explicitly mapped and production mutation is approved.

| Player | Existing owner UUID | Email |
| --- | --- | --- |
| Arkan | `f26ca205-54f6-43ce-9fa7-417b747faabe` | blocked / unknown |
| Ais | `5d93e7e4-fcb2-479d-bab2-a8c7924c5e8d` | blocked / unknown |

Do not infer either email from GitHub, account metadata, or personal context.

## Ownership model

Keep the existing player UUID as the canonical owner ID. Create each Supabase Auth user with the **same UUID** as `public.users.id`. Existing child foreign keys then already carry the authenticated owner ID, preserving all checklist/history data without a data-copy migration.

Authorization is based on `auth.uid()`, never user-editable metadata.

## Prepared tooling

- `scripts/create-auth-user.mjs`: UUID/email validation, legacy-profile preflight, collision detection, `--dry-run`, idempotent correct mapping.
- `supabase/sql/enforce_auth_ownership.sql`: guarded FK + anon revocation + owner RLS + secure default privileges.
- `supabase/sql/verify_security_post_rollout.sql`: read-only post-rollout report.
- `supabase/tests/database/auth_ownership_rls.test.sql`: pgTAP own-access, cross-player denial, and unauthenticated denial.

## Production rollout order

1. Receive explicit Arkan/Ais email mapping plus approval to mutate production Auth/RLS.
2. Reconfirm target project ref `ispfhvdelglwvixaspza` (`superhuman`).
3. Dry-run both provisioning commands, then provision both Auth users with existing UUIDs.
4. Confirm Auth Site URL / redirect URLs for the deployed app.
5. For this existing remote project, establish a proper CLI migration baseline with `supabase db pull` and review it.
6. Create the real migration with `supabase migration new enforce_auth_ownership`; copy in the reviewed staged SQL.
7. Run local `supabase db reset` and `supabase test db`.
8. Run `supabase db push --dry-run` against the explicitly linked project; only then apply.
9. Run the post-rollout verification SQL plus Security Advisor and Performance Advisor.
10. Verify real magic-link login for both players, cross-player read/write denial, existing checklist/daily-quest/history regression, and unauthenticated denial.
11. Only after PASS, apply the separately staged Life Vault schema.

Never run `supabase db reset --linked` against production.

## Provisioning

```bash
SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
node scripts/create-auth-user.mjs --dry-run <existing-player-uuid> <player-email>

SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
node scripts/create-auth-user.mjs <existing-player-uuid> <player-email>
```

`SUPABASE_SERVICE_ROLE_KEY` is a legacy fallback. Never expose an admin key with `NEXT_PUBLIC_`.

## Login behavior

The root screen uses email magic links with `shouldCreateUser: false`. Unknown emails are not auto-created. After authentication, the app resolves `public.users.id = auth.users.id` and routes only to that player. Human-readable `[username]` routes are not an authorization boundary; RLS is.

## Safety / rollback

Prefer **roll-forward** over deleting Auth users or restoring public anonymous access. `users_auth_user_fkey` uses `ON DELETE RESTRICT` so an Auth identity that owns a legacy player cannot be deleted accidentally.

If enforcement exposes an app regression, first verify session/redirect configuration and UUID ownership. Restoring old `anon ... true` policies would expand production access and therefore requires its own explicit security decision; never do it silently.

Before any production DB mutation, capture the current policy/grant state and verify the project's available backup/recovery option.
