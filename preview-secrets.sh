#!/bin/sh
# Cloudflare 빌드용 값을 이 브랜치의 미리보기에 비밀값으로 전달합니다.
# 값 자체는 이 파일에 없고, 로그에도 출력되지 않습니다.
set -e
# Vendor the pinned browser encoder at build time, never execute remote scripts on member devices.
# If the package cannot be obtained, the existing compressor remains available.
(
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  cd "$tmp"
  npm pack mediabunny@1.65.2 --silent > pack-name
  tar -xzf "$(cat pack-name)"
  bundle=$(find package -name mediabunny.mjs -type f | head -n 1)
  test -n "$bundle"
  mkdir -p "$OLDPWD/cloudflare-assets/vendor"
  cp "$bundle" "$OLDPWD/cloudflare-assets/vendor/mediabunny.mjs"
  if [ -f package/LICENSE ]; then cp package/LICENSE "$OLDPWD/cloudflare-assets/vendor/mediabunny-LICENSE"; fi
) || echo "Optional fast encoder unavailable; legacy compression remains enabled."
for k in SUPABASE_URL SUPABASE_SECRET_KEY TRAINER_PASSWORD; do
  eval "v=\$$k"
  if [ -z "$v" ]; then echo "missing build variable: $k"; exit 1; fi
  if output=$(printf '%s' "$v" | npx wrangler preview secret put "$k" --name "$WORKERS_CI_BRANCH" 2>&1); then
    :
  elif printf '%s' "$output" | grep -Fq "There are currently no deployments for the Preview"; then
    echo "Initial preview deployment required; bootstrap without fast-read secrets. Rebuild after deployment."
    exit 0
  else
    echo "Failed to configure preview secret: $k"
    exit 1
  fi
  echo "set preview secret: $k"
done
# 회원 화면 빠른 조회용 출입증 서명키 (선택). 없으면 회원 화면은 기존 방식(Sheets)만 씁니다.
if [ -n "$MEMBER_SESSION_SECRET" ]; then
  printf '%s' "$MEMBER_SESSION_SECRET" | npx wrangler preview secret put MEMBER_SESSION_SECRET --name "$WORKERS_CI_BRANCH"
  echo "set preview secret: MEMBER_SESSION_SECRET"
else
  echo "skip optional build variable: MEMBER_SESSION_SECRET"
fi
# ok4

# Rebuild after initial preview deployment to provision runtime secrets.
