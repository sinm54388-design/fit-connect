#!/bin/sh
# Cloudflare 빌드용 값을 이 브랜치의 미리보기에 비밀값으로 전달합니다.
# 값 자체는 이 파일에 없고, 로그에도 출력되지 않습니다.
set -e
for k in SUPABASE_URL SUPABASE_SECRET_KEY TRAINER_PASSWORD; do
  eval "v=\$$k"
  if [ -z "$v" ]; then echo "missing build variable: $k"; exit 1; fi
  printf '%s' "$v" | npx wrangler preview secret put "$k" --name "$WORKERS_CI_BRANCH"
  echo "set preview secret: $k"
done
# ok

