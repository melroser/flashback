#!/usr/bin/env bash
# Structural invariants. Cheap, dependency-free, and runs in CI or pre-deploy.
set -uo pipefail
fail=0

offenders=$(grep -rln "blobs/media" --include=*.ts --include=*.tsx lib app components 2>/dev/null \
  | grep -v '^lib/media/serve.ts$' | grep -v '^lib/media/purge.ts$' | grep -v '^lib/blobs/media.ts$' || true)
if [ -n "$offenders" ]; then
  echo "FAIL: media store imported outside serve.ts/purge.ts:"; echo "$offenders"; fail=1
else
  echo "OK: media store import restricted"
fi

if grep -rn "from 'next/image'" --include=*.tsx app components 2>/dev/null; then
  echo "FAIL: next/image would cache protected bytes outside the gate"; fail=1
else
  echo "OK: no next/image"
fi

if grep -rn "getDeployStore" --include=*.ts lib scripts 2>/dev/null; then
  echo "FAIL: deploy-scoped store would orphan media on redeploy"; fail=1
else
  echo "OK: no deploy-scoped stores"
fi

if find public -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.mp4' -o -iname '*.mov' \) 2>/dev/null | grep -q .; then
  echo "FAIL: media bytes found under public/ (would be served with no auth)"; fail=1
else
  echo "OK: no media under public/"
fi

exit $fail
