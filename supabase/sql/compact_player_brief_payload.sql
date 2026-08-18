-- Keep the canonical Player Brief compact even as granular player memory grows.
-- Granular details remain in derived_understanding and are retrieved only when needed;
-- the brief carries bounded summaries/current-state metadata only.

alter table public.derived_understanding
  drop constraint if exists derived_understanding_summary_length_check;
alter table public.derived_understanding
  add constraint derived_understanding_summary_length_check
  check (char_length(summary) <= 600);

alter table public.derived_understanding
  drop constraint if exists derived_understanding_details_size_check;
alter table public.derived_understanding
  add constraint derived_understanding_details_size_check
  check (octet_length(details::text) <= 4096);

alter table public.player_briefs
  drop constraint if exists player_briefs_payload_size_check;
alter table public.player_briefs
  add constraint player_briefs_payload_size_check
  check (octet_length(brief::text) <= 65536);

create or replace function public.build_player_brief_json(p_user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
with player as (
  select id, name, timezone
  from public.users
  where id = p_user_id
), ranked_understanding as (
  select
    u.*,
    row_number() over (
      partition by u.understanding_type
      order by u.importance desc, u.last_observed_at desc, u.id
    ) as type_rank
  from public.derived_understanding u
  where u.user_id = p_user_id
    and u.status = 'active'
), selected_understanding as (
  select *
  from ranked_understanding
  where type_rank <= 6
), highlights as (
  select *
  from selected_understanding
  order by importance desc, last_observed_at desc, id
  limit 6
), selected_signals as (
  select s.*
  from public.player_signals s
  where s.user_id = p_user_id
    and (s.expires_at is null or s.expires_at >= now())
  order by s.importance desc, s.observed_at desc, s.id
  limit 12
)
select jsonb_build_object(
  'schemaVersion', 'player-brief.v1',
  'generatedAt', now(),
  'player', jsonb_build_object(
    'id', player.id,
    'name', player.name,
    'timezone', player.timezone
  ),
  'activeUnderstandingIds', coalesce((
    select jsonb_agg(u.id order by u.importance desc, u.last_observed_at desc, u.id)
    from selected_understanding u
  ), '[]'::jsonb),
  'highlights', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', h.id,
      'type', h.understanding_type,
      'summary', h.summary,
      'confidence', h.confidence,
      'importance', h.importance,
      'firstObservedAt', h.first_observed_at,
      'lastObservedAt', h.last_observed_at
    ) order by h.importance desc, h.last_observed_at desc, h.id)
    from highlights h
  ), '[]'::jsonb),
  'sections', jsonb_build_object(
    'goals', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='goal'), '[]'::jsonb),
    'obstacles', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='obstacle'), '[]'::jsonb),
    'opportunities', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='opportunity'), '[]'::jsonb),
    'constraints', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='constraint'), '[]'::jsonb),
    'preferences', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='preference'), '[]'::jsonb),
    'relationships', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='relationship'), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='event'), '[]'::jsonb),
    'priorities', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='priority'), '[]'::jsonb)
  ),
  'activeSignals', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id,
      'type', s.signal_type,
      'summary', s.summary,
      'importance', s.importance,
      'confidence', s.confidence,
      'observedAt', s.observed_at,
      'sourceUnderstandingId', s.source_understanding_id
    ) order by s.importance desc, s.observed_at desc, s.id)
    from selected_signals s
  ), '[]'::jsonb),
  'counts', jsonb_build_object(
    'activeUnderstanding', (select count(*) from public.derived_understanding u where u.user_id=p_user_id and u.status='active'),
    'briefUnderstanding', (select count(*) from selected_understanding),
    'activeSignals', (select count(*) from public.player_signals s where s.user_id=p_user_id and (s.expires_at is null or s.expires_at >= now())),
    'briefSignals', (select count(*) from selected_signals)
  )
)
from player;
$function$;

-- Player Brief rows are immutable snapshots. Create a new compact version instead of
-- mutating the existing current row in place.
do $block$
declare
  v_user_id uuid;
begin
  for v_user_id in select user_id from public.player_briefs where is_current loop
    perform public.refresh_player_brief_internal(v_user_id,'compact_brief_hardening');
  end loop;
end
$block$;

revoke all on function public.build_player_brief_json(uuid) from public,anon,authenticated;
