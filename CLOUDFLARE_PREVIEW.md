# FIT-CONNECT Cloudflare Preview

This file documents the isolated Cloudflare Worker preview for FIT-CONNECT.

## Layout

- Branch: `perf-diagnostics-20261114` (never deploy production from this branch; `main` is production).
- Config: `wrangler.jsonc` (empty `previews` block on purpose).
- Cloudflare Worker: `cloudflare-worker.js`.
- HTML assets: `public/index.html` (the root `index.html` is not served by the Worker).
- Preview URL: `https://perf-diagnostics-20261114-fit-connect.sinm54388.workers.dev/?fastdb=1&perf=1`

## Fast-read pilot (`?fastdb=1`, preview only)

- Worker route `POST /api/records` is **read-only**.
  Trainer password: `verify`, `read` (one daily record), `trainerOverview`, `workoutHistory`,
  `memberInsights` (weekly/monthly/strength only; InBody, PT and goal still come from Apps Script).
- Member links: `memberSession` asks Apps Script whether the member link is valid and, if so,
  returns an 8-hour session signed with `MEMBER_SESSION_SECRET`. A session can only call
  `read`, `workoutHistory` and `memberInsights` for that one member. The page stores only the
  session (never records) in the browser. A rotated link is refused by Apps Script at once;
  the page then drops the session and falls back to Sheets.
- Google Apps Script / Sheets stays canonical for all writes and member tokens.
- Every fast result is shown first and then replaced by the Apps Script result;
  any mismatch is logged in the `perf=1` panel (for daily records it also stops
  using the fast copy for that member/date until reload).
- Member-link screens use the fast path from the second read on (after a session is issued).

## Secrets

`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `TRAINER_PASSWORD` are runtime preview secrets.
`MEMBER_SESSION_SECRET` (random, 64 chars) is optional; without it member screens use Sheets only.

- Previews Base **runtime** secrets cannot be set in the dashboard because the
  production Worker (`main`) is static-assets only.
- Instead, the three values are stored as **Builds → Previews Base** variables, and the
  Previews Base build command `sh preview-secrets.sh` copies them into this branch's
  preview with `wrangler preview secret put` (values are never printed).
- Production builds must not hold these values (removed on 2026-11-15).
- Previews Base build variables are copied only into **new** previews. An existing preview
  has its own Builds variables (Worker → choose the preview in the top selector → Settings →
  Builds); add new variables there too, then push a commit to rebuild.

## Parity checks

- `perf=1` panel → **전체 회원 검사 (읽기 전용)** reads every member from both backends and
  reports matches by list position only (no names or values).
- 2026-11-15: 7/7 members match for daily records and workout history.
- Two old Supabase-only test rows (2020-01-01, 2020-01-02) were moved to
  `fit_daily_records_test_backup` and deleted from `fit_daily_records`.

## Before any production rollout

Verify record parity again, fallback to Apps Script, member access rules, and that the
preview never writes to production data.
