-- Applied to FIT-CONNECT production Supabase on 2026-11-18.
-- The Worker accesses this RLS-protected table with its server-side secret only.
create table if not exists public.fit_columns (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 3 and 90),
  category text not null check (category in ('영양/식단','트레이닝','회복/습관')),
  summary text not null check (char_length(summary) between 10 and 280),
  content jsonb not null default '[]'::jsonb,
  author text not null default '신명진 코치' check (char_length(author) between 2 and 50),
  published_at date not null default current_date,
  status text not null default 'published' check (status in ('draft','published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.fit_columns enable row level security;
revoke all on table public.fit_columns from anon, authenticated;
create index if not exists fit_columns_feed_idx on public.fit_columns (status, published_at desc);