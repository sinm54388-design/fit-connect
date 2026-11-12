-- FIT-CONNECT video metadata migration - PREPARATION ONLY
-- This file is NOT executed by GitHub/Vercel. Review and run manually
-- against the staging Supabase project only after a complete source audit.
-- Preserve Google Drive binary files, existing ids, access links and feedback.
--
-- Verify the source payloads of listExerciseVideos and listFormVideos first:
-- exercise fields observed in UI: id, name, url, fileId, tip
-- form fields observed in UI: id, name, fileId, question, feedback, readAt
-- Additional source fields may exist; retain them in raw_payload.
-- All videos belong to a member. The source record ID must be confirmed
-- non-empty and stable before running an import/upsert.
--
create table if not exists public.fit_video_metadata (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.fit_members(id) on delete restrict,
  kind text not null check (kind in ('exercise', 'form')),
  source_id text not null check (length(btrim(source_id)) > 0),
  name text not null default '',
  file_id text,
  external_url text,
  tip text not null default '',
  question text not null default '',
  feedback text not null default '',
  read_at text,
  raw_payload jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fit_video_metadata_unique_source unique(member_id,kind,source_id)
);
create index if not exists fit_video_metadata_member_kind_idx
  on public.fit_video_metadata(member_id,kind,imported_at desc);
alter table public.fit_video_metadata enable row level security;
-- Browser never directly receives a Supabase service key or raw table grants.
-- All future reads/writes must go through authenticated /api/records
-- after verifying member token or trainer password on the server.
revoke all on public.fit_video_metadata from anon, authenticated;

-- Migration validation (run read-only after staging import):
-- 1) Total count per member/kind matches the original Sheets source.
-- 2) Every source_id is unique within member/kind.
-- 3) Every Google Drive file_id and external_url matches its source.
-- 4) Every feedback, read_at, question and tip matches exactly.
-- 5) Media playback and member isolation work under existing credentials.
-- 6) Compare data added to Sheets after the initial snapshot.
-- 7) Keep old video API/Drive unchanged until dual-read parity is proven.
-- 8) Do NOT delete the Sheets/Drive originals as part of migration.
