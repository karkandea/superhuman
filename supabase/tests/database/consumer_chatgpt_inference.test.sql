begin;

create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email) values
  ('77777777-7777-4777-8777-777777777777', 'consumer-a@example.invalid'),
  ('88888888-8888-4888-8888-888888888888', 'consumer-b@example.invalid');

insert into public.users (id, name) values
  ('77777777-7777-4777-8777-777777777777', '__consumer_a__'),
  ('88888888-8888-4888-8888-888888888888', '__consumer_b__');

set local role authenticated;
set local "request.jwt.claim.sub" = '77777777-7777-4777-8777-777777777777';

select lives_ok($$
  select public.request_progression_cycle('2099-01-02')
$$, 'player can request a progression cycle');

select results_eq(
  $$select count(*)::bigint from public.ai_inference_jobs$$,
  $$values (1::bigint)$$,
  'player only sees the requested job'
);

select results_eq(
  $$select (public.request_progression_cycle('2099-01-02')).id$$,
  $$select id from public.ai_inference_jobs where target_date = '2099-01-02'$$,
  'duplicate request returns the same player/date job'
);

set local "request.jwt.claim.sub" = '88888888-8888-4888-8888-888888888888';
select results_eq(
  $$select count(*)::bigint from public.ai_inference_jobs$$,
  $$values (0::bigint)$$,
  'another player cannot see the job'
);

reset role;
set local role anon;
set local "request.jwt.claim.sub" = '';
select throws_ok($$select * from public.ai_inference_jobs$$, '42501', null, 'anon cannot read inference jobs');

reset role;
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';

select results_eq(
  $$select (public.claim_ai_inference_job('worker-test', 300)).status$$,
  $$values ('running'::text)$$,
  'service worker atomically claims the queued job'
);

select results_eq(
  $$select attempt_count::integer from public.ai_inference_jobs where user_id = '77777777-7777-4777-8777-777777777777'$$,
  $$values (1)$$,
  'claim increments attempt count exactly once'
);

select ok(
  public.heartbeat_ai_inference_job(
    (select id from public.ai_inference_jobs where user_id = '77777777-7777-4777-8777-777777777777'),
    'worker-test',
    300
  ),
  'owning worker can extend the lease'
);

select results_eq(
  $$select (public.complete_ai_inference_job(
      (select id from public.ai_inference_jobs where user_id = '77777777-7777-4777-8777-777777777777'),
      'worker-test',
      'succeeded',
      'chatgpt-consumer-web',
      '["conversation-test"]'::jsonb,
      '{"questCount":1}'::jsonb
    )).status$$,
  $$values ('succeeded'::text)$$,
  'worker can complete only its claimed job'
);

reset role;
select * from finish();
rollback;
