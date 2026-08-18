begin;

create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email) values
  ('55555555-5555-4555-8555-555555555555', 'progression-a@example.invalid'),
  ('66666666-6666-4666-8666-666666666666', 'progression-b@example.invalid');

insert into public.users (id, name) values
  ('55555555-5555-4555-8555-555555555555', '__progression_a__'),
  ('66666666-6666-4666-8666-666666666666', '__progression_b__');

insert into public.knowledge_sources (id, user_id, source_type, title) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '55555555-5555-4555-8555-555555555555', 'life_update', 'Interview'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', '66666666-6666-4666-8666-666666666666', 'note', 'Private B');

insert into public.knowledge_entries (id, user_id, source_id, entry_type, raw_text) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '55555555-5555-4555-8555-555555555555', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'life_update', 'Interview gue gagal karena system design.'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', '66666666-6666-4666-8666-666666666666', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'note', 'Private player B knowledge');

select lives_ok($$
  select public.persist_derived_understanding(
    '55555555-5555-4555-8555-555555555555',
    '[{"type":"obstacle","summary":"System design is blocking interviews","details":{},"confidence":0.92,"importance":5,"sourceKnowledgeEntryIds":["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"],"evidenceExcerpt":"gagal karena system design"}]'::jsonb,
    array['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2']::uuid[],
    '{}'::uuid[],
    'test-provider', 'test-model', 'request-understanding-1', 'understanding.v1',
    '2099-01-01T08:00:00Z'::timestamptz,
    '{"strategy":"explicit_knowledge_plus_recent_signals"}'::jsonb
  )
$$, 'derived understanding persists atomically');

select results_eq(
  $$select count(*)::bigint from public.understanding_sources where user_id = '55555555-5555-4555-8555-555555555555'$$,
  $$values (1::bigint)$$,
  'derived understanding keeps raw knowledge provenance'
);

select results_eq(
  $$select count(*)::bigint from public.context_snapshot_knowledge where user_id = '55555555-5555-4555-8555-555555555555'$$,
  $$values (1::bigint)$$,
  'understanding context snapshot records selected raw knowledge'
);

select results_eq(
  $$select importance::integer from public.player_signals where user_id = '55555555-5555-4555-8555-555555555555' limit 1$$,
  $$values (5)$$,
  'derived understanding emits an explicit importance signal'
);

select throws_ok($$
  select public.persist_derived_understanding(
    '55555555-5555-4555-8555-555555555555',
    '[{"type":"obstacle","summary":"cross-player","details":{},"confidence":0.9,"importance":5,"sourceKnowledgeEntryIds":["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2"]}]'::jsonb,
    array['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2']::uuid[]
  )
$$, 'P0001', 'Knowledge context contains missing or cross-player entries', 'cross-player raw provenance is rejected');

insert into public.daily_quests (
  id, user_id, quest_date, title, category, kind, difficulty, priority, xp, rationale, source, status
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  '55555555-5555-4555-8555-555555555555',
  '2098-12-31',
  'Previous quest', 'siang', 'main', 'medium', 1, 100, 'Previous evidence', 'system', 'failed'
);

insert into public.quest_results (id, user_id, quest_id, outcome, note) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
  '55555555-5555-4555-8555-555555555555',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  'failed',
  'Need more system design practice'
);

select lives_ok($$
  select public.persist_daily_quest_batch(
    '55555555-5555-4555-8555-555555555555',
    '2099-01-01',
    array[(select id from public.player_signals where user_id = '55555555-5555-4555-8555-555555555555' limit 1)]::uuid[],
    array['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4']::uuid[],
    jsonb_build_array(jsonb_build_object(
      'title', 'Practice one system design interview problem',
      'category', 'siang',
      'kind', 'main',
      'difficulty', 'medium',
      'priority', 1,
      'xp', 100,
      'rationale', 'Addresses the active system design obstacle',
      'sourceSignalIds', jsonb_build_array((select id::text from public.player_signals where user_id = '55555555-5555-4555-8555-555555555555' limit 1))
    )),
    'test-provider', 'test-model', 'request-quest-1', 'daily-quest.v1',
    '2099-01-01T09:00:00Z'::timestamptz,
    '{"strategy":"active_signals_plus_recent_quest_results"}'::jsonb
  )
$$, 'daily quest batch persists from bounded evidence');

select results_eq(
  $$select count(*)::bigint from public.context_snapshot_quest_results where user_id = '55555555-5555-4555-8555-555555555555'$$,
  $$values (1::bigint)$$,
  'daily context snapshot records recent quest outcome provenance'
);

select lives_ok($$
  select public.persist_daily_quest_batch(
    '55555555-5555-4555-8555-555555555555',
    '2099-01-01',
    array[(select id from public.player_signals where user_id = '55555555-5555-4555-8555-555555555555' limit 1)]::uuid[],
    array['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4']::uuid[],
    '[{"title":"This duplicate must not be inserted","category":"siang","kind":"side","difficulty":"easy","priority":2,"xp":10,"rationale":"duplicate request","sourceSignalIds":["00000000-0000-4000-8000-000000000000"]}]'::jsonb
  )
$$, 'same-date persistence returns the existing batch without regenerating');

select results_eq(
  $$select count(*)::bigint from public.daily_quests where user_id = '55555555-5555-4555-8555-555555555555' and quest_date = '2099-01-01'$$,
  $$values (1::bigint)$$,
  'one persisted quest remains for the date after duplicate generation request'
);

select results_eq(
  $$select count(*)::bigint from public.quest_batches where user_id = '55555555-5555-4555-8555-555555555555' and quest_date = '2099-01-01'$$,
  $$values (1::bigint)$$,
  'only one quest batch exists per player per date'
);

select * from finish();
rollback;
