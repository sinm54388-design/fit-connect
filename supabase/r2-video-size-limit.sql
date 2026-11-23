-- Allow larger videos only for R2-backed records.
alter table public.fit_direct_videos
  drop constraint fit_direct_videos_size_bytes_check,
  add constraint fit_direct_videos_size_bytes_check
    check (size_bytes between 1 and
      case when left(storage_path, 3) = 'r2/' then 100000000 else 50000000 end);
