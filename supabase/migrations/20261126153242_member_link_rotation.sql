alter table public.fit_members
  add column if not exists worker_link_generation uuid,
  add column if not exists worker_link_expires_at timestamptz;

CREATE OR REPLACE FUNCTION public.fit_member_day_snapshot(p_name text, p_date date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce((
    select jsonb_build_object(
      'member', jsonb_build_object('id', m.id, 'is_archived', m.is_archived, 'worker_link_sha256', m.worker_link_sha256,
        'worker_link_generation', m.worker_link_generation,
        'worker_link_expires_at', m.worker_link_expires_at),
      'daily', case when m.is_archived then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('data', d.data))
        from public.fit_daily_records d
        where d.member_id = m.id and d.record_date = p_date
      ), '[]'::jsonb) end,
      'photos', case when m.is_archived then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('meal_key', p.meal_key, 'photo', p.photo) order by p.meal_key)
        from public.fit_meal_photos p
        where p.member_id = m.id and p.record_date = p_date
          and p.meal_key in ('breakfast','lunch','dinner','snack')
      ), '[]'::jsonb) end,
      'feedback', case when m.is_archived then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object(
          'header_message', f.header_message,
          'workout_feedback', f.workout_feedback,
          'diet_feedback', f.diet_feedback
        ))
        from public.fit_coach_feedback f
        where f.member_id = m.id and f.record_date = p_date
      ), '[]'::jsonb) end
    )
    from public.fit_members m
    where m.name = p_name
    limit 1
  ), '{"member":null}'::jsonb);
$function$;
revoke execute on function public.fit_member_day_snapshot(text, date) from public, anon, authenticated;
grant execute on function public.fit_member_day_snapshot(text, date) to service_role;
notify pgrst, 'reload schema';
