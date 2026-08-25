-- Apply only after the frontend using start_progression_cycle_after_checkin is live.
-- This removes the remaining client-side path that could reset/requeue an existing job.

revoke all on function public.request_progression_cycle(date) from public, anon, authenticated;
grant execute on function public.request_progression_cycle(date) to service_role;
