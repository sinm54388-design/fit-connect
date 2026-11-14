# FIT-CONNECT Cloudflare Preview

This file documents the isolated Cloudflare Worker preview for FIT-CONNECT.

## Layout

- Branch: `perf-diagnostics-20261114` (never deploy production from this branch; `main` is production).
- Config: `wrangler.jsonc` (empty `previews` block on purpose).
- Cloudflare Worker: `cloudflare-worker.js`.
- HTML assets: `public/index.html` (the root `index.html` is not served by the Worker).
- Preview URL: `https://perf-diagnostics-20261114-fit-connect.sinm54388.workers.dev/?fastdb=1&perf=1`

## Fast-read pilot (`?fastdb=1`, preview only)

- Worker route `POST /api/records` is **read-only** and requires the trainer password.
  Actions: `verify`, `read` (one daily record), `trainerOverview`, `workoutHistory`.
- Google Apps Script / Sheets stays canonical for all writes and member (token) links.
- Every fast result is shown first and then replaced by the Apps Script result;
  any mismatch is logged in the `perf=1` panel (for daily records it also stops
  using the fast copy for that member/date until reload).
- Member-link (token) screens do not use the fast path yet.

## Secrets

`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `TRAINER_PASSWORD` are runtime preview secrets.

- Previews Base **runtime** secrets cannot be set in the dashboard because the
  production Worker (`main`) is static-assets only.
- Instead, the three values are stored as **Builds → Previews Base** variables, and the
  Previews Base build command `sh preview-secrets.sh` copies them into this branch's
  preview with `wrangler preview secret put` (values are never printed).
- Production builds must not hold these values (removed on 2026-11-15).

## Parity checks

- `perf=1` panel → **전체 회원 검사 (읽기 전용)** reads every member from both backends and
  reports matches by list position only (no names or values).
- 2026-11-15: 7/7 members match for daily records and workout history.
- Two old Supabase-only test rows (2020-01-01, 2020-01-02) were moved to
  `fit_daily_records_test_backup` and deleted from `fit_daily_records`.

## Before any production rollout

Verify record parity again, fallback to Apps Script, member access rules, and that the
preview never writes to production data.
