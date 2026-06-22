-- Atomically increment framing stats after a session outcome.
-- Called by the mobile app's outcomeRecorder service.

create or replace function public.increment_framing_stat(
  p_user_id uuid,
  p_framing text,
  p_resisted boolean
) returns void language plpgsql security definer as $$
begin
  insert into public.user_framing_stats (user_id, framing, shown_count, resisted_after)
  values (p_user_id, p_framing, 1, case when p_resisted then 1 else 0 end)
  on conflict (user_id, framing) do update set
    shown_count = user_framing_stats.shown_count + 1,
    resisted_after = user_framing_stats.resisted_after + case when p_resisted then 1 else 0 end;
end;
$$;
