begin;

create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users (id, email) values
  ('33333333-3333-4333-8333-333333333333', 'vault-a@example.invalid'),
  ('44444444-4444-4444-8444-444444444444', 'vault-b@example.invalid');

insert into public.users (id, name) values
  ('33333333-3333-4333-8333-333333333333', '__vault_player_a__'),
  ('44444444-4444-4444-8444-444444444444', '__vault_player_b__');

set local role authenticated;
set local "request.jwt.claim.sub" = '33333333-3333-4333-8333-333333333333';

select lives_ok(
  $$select public.ingest_manual_knowledge('life_update', 'Interview gue gagal karena system design.', 'Interview update')$$,
  'player A can ingest a natural life update'
);

select results_eq(
  $$select count(*)::bigint from public.knowledge_entries$$,
  $$values (1::bigint)$$,
  'player A sees only their raw knowledge'
);

select results_eq(
  $$select raw_text from public.knowledge_entries limit 1$$,
  $$values ('Interview gue gagal karena system design.'::text)$$,
  'raw knowledge is preserved verbatim'
);

select throws_ok(
  $$update public.knowledge_entries set processing_status = 'processed'$$,
  '42501', null,
  'client cannot forge knowledge processing status'
);

select throws_ok(
  $$insert into public.derived_understanding (user_id, understanding_type, summary, confidence, extraction_version) values ('33333333-3333-4333-8333-333333333333', 'obstacle', 'fake', 1, 'test')$$,
  '42501', null,
  'client cannot write derived understanding directly'
);

reset role;
insert into public.knowledge_sources (user_id, source_type, title) values
  ('44444444-4444-4444-8444-444444444444', 'note', 'B note');
insert into public.knowledge_entries (user_id, source_id, entry_type, raw_text)
select '44444444-4444-4444-8444-444444444444', id, 'note', 'private B knowledge'
from public.knowledge_sources
where user_id = '44444444-4444-4444-8444-444444444444';

set local role authenticated;
set local "request.jwt.claim.sub" = '33333333-3333-4333-8333-333333333333';
select results_eq(
  $$select count(*)::bigint from public.knowledge_entries$$,
  $$values (1::bigint)$$,
  'player A cannot read player B knowledge'
);
select results_eq(
  $$select count(*)::bigint from public.knowledge_entries where user_id = '44444444-4444-4444-8444-444444444444'$$,
  $$values (0::bigint)$$,
  'explicit cross-player raw query is filtered by RLS'
);

reset role;
set local role anon;
set local "request.jwt.claim.sub" = '';
select throws_ok($$select * from public.knowledge_entries$$, '42501', null, 'anon cannot read Life Vault');
select throws_ok($$select public.ingest_manual_knowledge('note', 'nope')$$, '42501', null, 'anon cannot call ingestion RPC');
select throws_ok($$select * from public.player_signals$$, '42501', null, 'anon cannot read derived signals');

reset role;
select * from finish();
rollback;
