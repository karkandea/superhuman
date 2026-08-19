-- Finalize the Player Brief cutover after worker-v2 is live.
-- The legacy understanding.v1 persistence RPC was service-role only and existed solely
-- to protect the mixed-version deployment window. Current production progression uses
-- persist_understanding_delta, so fail closed if an obsolete worker is ever restarted.

drop function if exists public.persist_derived_understanding(
  uuid,
  jsonb,
  uuid[],
  uuid[],
  text,
  text,
  text,
  text,
  timestamptz,
  jsonb
);
