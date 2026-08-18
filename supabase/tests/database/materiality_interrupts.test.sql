begin;

create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users (id,email) values ('99999999-9999-4999-8999-999999999999','materiality@example.invalid');
insert into public.users (id,name,timezone) values ('99999999-9999-4999-8999-999999999999','__materiality__','Asia/Jakarta');

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';

insert into public.knowledge_sources(id,user_id,source_type,title,processing_status) values
  ('91000000-0000-4000-8000-000000000001','99999999-9999-4999-8999-999999999999','journal','Mood','processed'),
  ('91000000-0000-4000-8000-000000000002','99999999-9999-4999-8999-999999999999','life_update','Interview moved','processed'),
  ('91000000-0000-4000-8000-000000000003','99999999-9999-4999-8999-999999999999','wellness','Health change','processed');

insert into public.knowledge_entries(id,user_id,source_id,entry_type,raw_text,processing_status,materiality_status) values
  ('92000000-0000-4000-8000-000000000001','99999999-9999-4999-8999-999999999999','91000000-0000-4000-8000-000000000001','journal','Mood gue agak jelek hari ini.','processed','pending'),
  ('92000000-0000-4000-8000-000000000002','99999999-9999-4999-8999-999999999999','91000000-0000-4000-8000-000000000002','life_update','Interview gue dimajuin jadi jam 4 sore hari ini.','processed','pending'),
  ('92000000-0000-4000-8000-000000000003','99999999-9999-4999-8999-999999999999','91000000-0000-4000-8000-000000000003','wellness','Gue demam 39°C.','processed','pending');

insert into public.player_signals(id,user_id,signal_type,summary,importance,confidence,observed_at) values
  ('93000000-0000-4000-8000-000000000001','99999999-9999-4999-8999-999999999999','event','Interview at 16:00 today',5,0.95,'2099-01-02 08:00:00+00'),
  ('93000000-0000-4000-8000-000000000002','99999999-9999-4999-8999-999999999999','constraint','High fever today',5,0.98,'2099-01-02 08:00:00+00');

insert into public.quest_batches(id,user_id,quest_date,status,generation_version) values
  ('94000000-0000-4000-8000-000000000001','99999999-9999-4999-8999-999999999999','2099-01-02','generated','test.v1');

insert into public.daily_quests(id,user_id,batch_id,quest_date,title,category,kind,difficulty,priority,xp,rationale,source,status) values
  ('95000000-0000-4000-8000-000000000001','99999999-9999-4999-8999-999999999999','94000000-0000-4000-8000-000000000001','2099-01-02','Work on portfolio','siang','main','medium',2,100,'Original plan','ai','pending'),
  ('95000000-0000-4000-8000-000000000002','99999999-9999-4999-8999-999999999999','94000000-0000-4000-8000-000000000001','2099-01-02','Run 5 km','malam','side','medium',3,70,'Original plan','ai','pending');

select is(
  (public.persist_materiality_assessment(
    '99999999-9999-4999-8999-999999999999','92000000-0000-4000-8000-000000000001','2099-01-02',
    '{"isMaterial":false,"level":"low","confidence":0.88,"reason":"Mild mood change does not change an action today.","affectedQuestIds":[],"sourceSignalIds":[],"recommendedAction":"none","urgency":"none"}'::jsonb,
    array['93000000-0000-4000-8000-000000000001']::uuid[],
    array['95000000-0000-4000-8000-000000000001','95000000-0000-4000-8000-000000000002']::uuid[],
    'test','test','mood-request','materiality.v1','2099-01-02 09:00:00+00','Asia/Jakarta','2099-01-02T16:00:00','{}'::jsonb
  )->>'disposition'),
  'no_change',
  'non-material update persists no-change disposition'
);
select results_eq(
  $$select count(*)::bigint from public.quest_interrupts$$,
  $$values (0::bigint)$$,
  'non-material assessment creates no interrupt'
);
select results_eq(
  $$select status from public.daily_quests where id='95000000-0000-4000-8000-000000000001'$$,
  $$values ('pending'::text)$$,
  'non-material update leaves original quest unchanged'
);

select is(
  (public.persist_materiality_assessment(
    '99999999-9999-4999-8999-999999999999','92000000-0000-4000-8000-000000000002','2099-01-02',
    '{"isMaterial":true,"level":"high","confidence":0.94,"reason":"Interview moved to 16:00 today.","affectedQuestIds":["95000000-0000-4000-8000-000000000001"],"sourceSignalIds":["93000000-0000-4000-8000-000000000001"],"recommendedAction":"defer","urgency":"immediate"}'::jsonb,
    array['93000000-0000-4000-8000-000000000001']::uuid[],
    array['95000000-0000-4000-8000-000000000001','95000000-0000-4000-8000-000000000002']::uuid[],
    'test','test','interview-request','materiality.v1','2099-01-02 09:05:00+00','Asia/Jakarta','2099-01-02T16:05:00','{}'::jsonb
  )->>'disposition'),
  'auto_interrupt',
  'high-confidence immediate update qualifies for auto interrupt'
);

select is(
  (public.persist_quest_interrupt(
    '99999999-9999-4999-8999-999999999999',
    (select id from public.materiality_assessments where knowledge_entry_id='92000000-0000-4000-8000-000000000002'),
    '2099-01-02',
    '{"summary":"Interview prep becomes the immediate priority.","actions":[{"action":"defer","targetQuestId":"95000000-0000-4000-8000-000000000001","reason":"Portfolio remains valid but moves after the interview."},{"action":"add","reason":"Prepare before the newly moved interview.","quest":{"title":"60-minute interview preparation","category":"siang","kind":"main","difficulty":"medium","priority":1,"xp":100,"rationale":"Interview is now at 16:00 today.","sourceSignalIds":["93000000-0000-4000-8000-000000000001"]}}]}'::jsonb,
    array['93000000-0000-4000-8000-000000000001']::uuid[],
    array['95000000-0000-4000-8000-000000000001','95000000-0000-4000-8000-000000000002']::uuid[],
    'test','test','interrupt-request','system-interrupt.v1','2099-01-02 09:06:00+00','{}'::jsonb,true
  )->>'status'),
  'applied',
  'auto interrupt persists and applies atomically'
);
select results_eq(
  $$select status from public.daily_quests where id='95000000-0000-4000-8000-000000000001'$$,
  $$values ('deferred'::text)$$,
  'defer preserves original quest as historical row'
);
select results_eq(
  $$select count(*)::bigint from public.daily_quests where user_id='99999999-9999-4999-8999-999999999999' and source='system' and status='pending'$$,
  $$values (1::bigint)$$,
  'auto interrupt adds exactly one replacement priority quest'
);

select public.persist_quest_interrupt(
  '99999999-9999-4999-8999-999999999999',
  (select id from public.materiality_assessments where knowledge_entry_id='92000000-0000-4000-8000-000000000002'),
  '2099-01-02',
  '{"summary":"Duplicate retry","actions":[{"action":"add","reason":"duplicate","quest":{"title":"Duplicate","category":"siang","kind":"main","difficulty":"easy","priority":1,"xp":1,"rationale":"duplicate","sourceSignalIds":["93000000-0000-4000-8000-000000000001"]}}]}'::jsonb,
  array['93000000-0000-4000-8000-000000000001']::uuid[], '{}'::uuid[], 'test','test','duplicate','system-interrupt.v1',now(),'{}'::jsonb,true
);
select results_eq(
  $$select count(*)::bigint from public.daily_quests where user_id='99999999-9999-4999-8999-999999999999' and source='system'$$,
  $$values (1::bigint)$$,
  'duplicate interrupt processing creates no duplicate quest'
);

select public.persist_materiality_assessment(
  '99999999-9999-4999-8999-999999999999','92000000-0000-4000-8000-000000000003','2099-01-02',
  '{"isMaterial":true,"level":"medium","confidence":0.78,"reason":"Health update may warrant replacing workout.","affectedQuestIds":["95000000-0000-4000-8000-000000000002"],"sourceSignalIds":["93000000-0000-4000-8000-000000000002"],"recommendedAction":"replace","urgency":"today"}'::jsonb,
  array['93000000-0000-4000-8000-000000000002']::uuid[],
  array['95000000-0000-4000-8000-000000000002']::uuid[],
  'test','test','health-request','materiality.v1','2099-01-02 09:10:00+00','Asia/Jakarta','2099-01-02T16:10:00','{}'::jsonb
);
select public.persist_quest_interrupt(
  '99999999-9999-4999-8999-999999999999',
  (select id from public.materiality_assessments where knowledge_entry_id='92000000-0000-4000-8000-000000000003'),
  '2099-01-02',
  '{"summary":"Consider recovery instead of running.","actions":[{"action":"replace","targetQuestId":"95000000-0000-4000-8000-000000000002","reason":"Health changed after plan generation.","quest":{"title":"Rest and hydrate","category":"sepanjang_hari","kind":"main","difficulty":"easy","priority":1,"xp":50,"rationale":"Recovery fits the health constraint.","sourceSignalIds":["93000000-0000-4000-8000-000000000002"]}}]}'::jsonb,
  array['93000000-0000-4000-8000-000000000002']::uuid[],
  array['95000000-0000-4000-8000-000000000002']::uuid[],
  'test','test','health-interrupt','system-interrupt.v1','2099-01-02 09:11:00+00','{}'::jsonb,false
);

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '99999999-9999-4999-8999-999999999999';
select lives_ok($$select public.set_daily_quest_completion('95000000-0000-4000-8000-000000000002',true)$$,'player completes quest before suggested interrupt is applied');
select lives_ok($$select public.apply_suggested_quest_interrupt((select id from public.quest_interrupts where assessment_id=(select id from public.materiality_assessments where knowledge_entry_id='92000000-0000-4000-8000-000000000003')))$$,'suggested interrupt remains race-safe when target changed');
select results_eq(
  $$select status from public.daily_quests where id='95000000-0000-4000-8000-000000000002'$$,
  $$values ('completed'::text)$$,
  'completed quest history is never rewritten by later interrupt'
);
select results_eq(
  $$select after_state->>'skipped' from public.quest_interrupt_actions where target_quest_id='95000000-0000-4000-8000-000000000002'$$,
  $$values ('target_completed'::text)$$,
  'interrupt audit records why completed target was skipped'
);

reset role;
select * from finish();
rollback;
