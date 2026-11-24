alter table public.fit_members
  add column if not exists worker_link_sha256 text
  check (worker_link_sha256 ~ '^[0-9a-f]{64}$');

create function public.fit_worker_save_day(p_member_id uuid, p_date date, p_action text, p_payload jsonb, p_trainer boolean)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_data jsonb;
  next_data jsonb;
  patch jsonb;
  incoming jsonb;
  prior jsonb;
  merged jsonb;
  changes jsonb;
  memo jsonb;
  allowed text[];
begin
  perform 1 from public.fit_members
  where id = p_member_id and not is_archived and worker_link_sha256 is not null
  for share;
  if not found then raise exception 'member disabled'; end if;

  insert into public.fit_daily_records(member_id, record_date, data)
  values (p_member_id, p_date, '{}'::jsonb)
  on conflict (member_id, record_date) do nothing;
  select data into current_data from public.fit_daily_records
  where member_id = p_member_id and record_date = p_date for update;

  if p_action = 'setProgressBatch' then
    changes := p_payload->'changes';
    if jsonb_typeof(changes) is distinct from 'array' or jsonb_array_length(changes) not between 1 and 100
      then raise exception 'invalid set changes'; end if;
    if not p_trainer and exists (
      select 1 from jsonb_array_elements(changes) c
      where not exists (
        select 1 from jsonb_array_elements(coalesce(current_data->'routines','[]')) r
        where r->>'id' = c->>'id' and r->>'routineType' = 'homework'
      )
    ) then raise exception 'personal routine not found'; end if;
    return public.fit_save_daily(p_member_id,p_date,p_action,p_payload,p_trainer);
  end if;

  if p_action not in ('save','patchData') then raise exception 'unsupported action'; end if;
  patch := case when p_action = 'save' then p_payload->'data' else p_payload->'patch' end;
  if jsonb_typeof(patch) is distinct from 'object' then raise exception 'invalid daily patch'; end if;
  allowed := array['routines','reflection','diet','memos'];
  if p_trainer then allowed := allowed || array['feedback','headerMessage','ptScheduled','ptTime']; end if;
  if exists (select 1 from jsonb_object_keys(patch) k where not (k = any(allowed)))
    then raise exception 'unsupported fields'; end if;

  if patch ? 'routines' then
    if jsonb_typeof(patch->'routines') is distinct from 'array' then raise exception 'invalid routines'; end if;
    if p_trainer then
      merged := '[]';
      for incoming in select value from jsonb_array_elements(patch->'routines') loop
        select r into prior from jsonb_array_elements(coalesce(current_data->'routines','[]')) r
        where r->>'id' = incoming->>'id' and r->>'routineType' = 'homework' limit 1;
        if prior ? 'completedSets' and incoming->>'routineType' = 'homework' then
          incoming := jsonb_set(incoming,'{completedSets}',prior->'completedSets');
        end if;
        merged := merged || jsonb_build_array(incoming);
      end loop;
    else
      merged := coalesce(current_data->'routines','[]');
      for incoming in select value from jsonb_array_elements(patch->'routines') loop
        if incoming->>'routineType' = 'homework' and nullif(incoming->>'id','') is not null
           and not exists (select 1 from jsonb_array_elements(merged) r where r->>'id'=incoming->>'id') then
          merged := merged || jsonb_build_array(incoming);
        end if;
      end loop;
    end if;
    patch := jsonb_set(patch,'{routines}',merged);
  end if;

  next_data := public.fit_save_daily(p_member_id,p_date,'save',
    jsonb_build_object('data',patch - 'ptScheduled' - 'ptTime'),p_trainer);
  if patch ? 'ptScheduled' or patch ? 'ptTime' then
    if jsonb_typeof(patch->'ptScheduled') is distinct from 'boolean' then raise exception 'invalid schedule'; end if;
    next_data := next_data || jsonb_build_object('ptScheduled',patch->'ptScheduled',
      'ptTime',case when (patch->>'ptScheduled')::boolean then left(coalesce(patch->>'ptTime',''),40) else '' end);
  end if;
  if patch ? 'memos' then
    -- The original merge deduplicates IDs and enforces the author. Restore validated attachment fields for new memos only.
    select coalesce(jsonb_agg(case when prior_memo is null then
      item || case when source_memo->>'photo' ~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$'
        then jsonb_build_object('photo',source_memo->'photo') else '{}'::jsonb end
      || case when source_memo->>'videoId' ~ '^direct:[0-9a-fA-F-]{36}$'
        then jsonb_build_object('videoId',source_memo->'videoId') else '{}'::jsonb end
      else item end order by item_ord),'[]') into merged
    from jsonb_array_elements(next_data->'memos') with ordinality as list(item,item_ord)
    left join lateral (
      select v as prior_memo from jsonb_array_elements(coalesce(current_data->'memos','[]')) v where v->>'id'=item->>'id' limit 1
    ) previous on true
    left join lateral (
      select v as source_memo from jsonb_array_elements(patch->'memos') v
      where v->>'id'=item->>'id' and v->>'from'=item->>'from' limit 1
    ) supplied on true;
    next_data := jsonb_set(next_data,'{memos}',merged);
  end if;
  update public.fit_daily_records set data=next_data, updated_at=clock_timestamp()
  where member_id=p_member_id and record_date=p_date;
  return next_data;
end;
$$;
revoke execute on function public.fit_worker_save_day(uuid,date,text,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.fit_worker_save_day(uuid,date,text,jsonb,boolean) to service_role;

CREATE OR REPLACE FUNCTION public.fit_member_day_snapshot(p_name text, p_date date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce((
    select jsonb_build_object(
      'member', jsonb_build_object('id', m.id, 'is_archived', m.is_archived, 'worker_link_sha256', m.worker_link_sha256),
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
