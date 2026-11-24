create or replace function public.fit_worker_save_day(p_member_id uuid, p_date date, p_action text, p_payload jsonb, p_trainer boolean)
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
  baseline jsonb;
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
      baseline := p_payload->'baselineRoutineIds';
      if baseline is not null and jsonb_typeof(baseline) is distinct from 'array'
        then raise exception 'invalid routine baseline'; end if;
      for prior in select value from jsonb_array_elements(coalesce(current_data->'routines','[]')) loop
        if prior->>'id' is not null
           and (baseline is not null or prior->>'routineType' = 'homework')
           and not coalesce(baseline ? (prior->>'id'),false)
           and not exists (select 1 from jsonb_array_elements(merged) r where r->>'id'=prior->>'id') then
          merged := merged || jsonb_build_array(prior);
        end if;
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
