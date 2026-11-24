create function public.fit_guard_native_daily_writer()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- The header is routing metadata. The service role remains the API authorization boundary.
  if current_user = 'service_role'
     and (nullif(current_setting('request.headers', true), '')::jsonb->>'x-fit-record-writer')
         is distinct from 'fit-connect-worker'
     and exists (
       select 1 from public.fit_members m
       where m.id = new.member_id and m.worker_link_sha256 is not null
     ) then
    raise exception using errcode = '42501', message = 'use the FIT-CONNECT record writer';
  end if;
  return new;
end;
$$;

revoke execute on function public.fit_guard_native_daily_writer() from public, anon, authenticated;

create trigger fit_guard_native_daily_writer
before insert or update of data on public.fit_daily_records
for each row execute function public.fit_guard_native_daily_writer();
