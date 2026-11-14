-- New, isolated private member video records. Existing Sheets and tables are untouched.
create table if not exists public.fit_direct_videos (
 id uuid primary key,
 member_id text not null,
 storage_path text not null unique,
 name text not null,
 question text not null default '',
 feedback text not null default '',
 read_at timestamptz,
 mime text not null check (mime in ('video/mp4','video/webm','video/quicktime')),
 size_bytes bigint not null check (size_bytes between 1 and 20971520),
 state text not null default 'pending' check (state in ('pending','ready','deleted')),
 created_at timestamptz not null default now()
);
alter table public.fit_direct_videos enable row level security;
revoke all on public.fit_direct_videos from anon, authenticated;
grant select, insert, update on public.fit_direct_videos to service_role;
create index if not exists fit_direct_videos_member_idx on public.fit_direct_videos(member_id,state,created_at desc);
-- Dedicated private bucket, hard size and MIME limits.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('fit-direct-videos','fit-direct-videos',false,20971520,array['video/mp4','video/webm','video/quicktime'])
on conflict (id) do nothing;
