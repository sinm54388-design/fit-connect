# FIT-CONNECT Cloudflare Preview

This file documents the isolated Cloudflare Worker preview for FIT-CONNECT.

- Branch: `perf-diagnostics-20261114` (never deploy production from this branch).
- Config: `wrangler.jsonc`.
- Cloudflare Worker: `cloudflare-worker.js`.
- HTML assets: `public/index.html`.
- Fast-read pilot: append `?fastdb=1` to the **preview** URL only.
- Worker route `POST /api/records` is read-only for authorized trainer requests.
- Google Apps Script remains canonical for writes.
- Configure `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `TRAINER_PASSWORD` as **runtime preview secrets** (not build variables).
- Before rollout, verify record parity, fallback, member access, and that the Worker preview does not mutate production.

This commit exists to kick off Git-connected preview build after the Worker and static asset files were added.
