begin;

create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'rls-a@example.invalid'),
  ('22222222-2222-4222-8222-222222222222', 'rls-b@example.invalid');

insert into public.users (id, name) values
  ('11111111-1111-4111-8111-111111111111', '__rls_player_a__'),
  ('22222222-2222-4222-8222-222222222222', '__rls_player_b__');

insert into public.daily_logs (user_id, date, checked_ids, mission_text) values
  ('11111111-1111-4111-8111-111111111111', '2099-01-01', '{}', 'owner-a-original'),
  ('22222222-2222-4222-8222-222222222222', '2099-01-01', '{}', 'owner-b-original');

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';

select results_eq($$select count(*)::bigint from public.users$$, $$values (1::bigint)$$, 'player A only sees their own profile');
select results_eq($$select count(*)::bigint from public.daily_logs$$, $$values (1::bigint)$$, 'player A only sees their own daily log');
select lives_ok($$update public.daily_logs set mission_text = 'owner-a-updated' where user_id = '11111111-1111-4111-8111-111111111111'$$, 'player A can update their own daily log');
select results_eq($$update public.daily_logs set mission_text = 'cross-player-write' where user_id = '22222222-2222-4222-8222-222222222222' returning mission_text$$, $$select mission_text from public.daily_logs where false$$, 'player A cannot update player B daily log');

set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select results_eq($$select mission_text from public.daily_logs where user_id = '22222222-2222-4222-8222-222222222222'$$, $$values ('owner-b-original'::text)$$, 'player B data was not modified by player A');
select results_eq($$select count(*)::bigint from public.users$$, $$values (1::bigint)$$, 'player B only sees their own profile');

reset role;
set local role anon;
set local "request.jwt.claim.sub" = '';
select throws_ok($$select * from public.users$$, '42501', null, 'unauthenticated role cannot read players');
select throws_ok($$select * from public.daily_logs$$, '42501', null, 'unauthenticated role cannot read daily logs');

reset role;
select * from finish();
rollback;
