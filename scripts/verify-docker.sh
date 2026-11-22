#!/usr/bin/env bash
# Builds the image, starts it with throwaway configuration and checks that Docker reports it healthy,
# GET /api/health answers 200, the process is non-root, and SIGTERM stops it cleanly (exit code 0).
set -euo pipefail

cd "$(dirname "$0")/.."
IMAGE=cloud-sync:verify
NAME=cloud-sync-verify-$$
PORT=${VERIFY_PORT:-3999}

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker build -t "$IMAGE" .

hash=$(printf 'verify-password' | npx --no-install tsx src/server/cli/hash-password.ts 2>/dev/null)
hash=${hash//\'/} # `docker run -e` does not strip the .env quoting
totp=$(npx --no-install tsx src/server/cli/totp-generate.ts 2>/dev/null)
secrets=$(npx --no-install tsx src/server/cli/generate-secrets.ts 2>/dev/null)

docker run -d --name "$NAME" -p "$PORT:3000" \
  -e USER_NAME=admin \
  -e "$hash" -e "$totp" \
  $(echo "$secrets" | sed 's/^/-e /') \
  -e GOOGLE_CLIENT_ID=verify -e GOOGLE_CLIENT_SECRET=verify \
  "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$NAME")
  [ "$status" = healthy ] && break
  sleep 2
done
[ "$status" = healthy ] || { docker logs "$NAME"; echo "FAIL: container not healthy ($status)"; exit 1; }

curl -fsS "http://127.0.0.1:$PORT/api/health" | grep -q '"status":"ok"' || { echo "FAIL: /api/health"; exit 1; }
[ "$(docker exec "$NAME" id -u)" != 0 ] || { echo "FAIL: running as root"; exit 1; }

docker stop -t 30 "$NAME" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
[ "$code" = 0 ] || { docker logs "$NAME"; echo "FAIL: exit code $code after SIGTERM"; exit 1; }
docker logs "$NAME" 2>&1 | grep -q 'shutting down' || { echo "FAIL: no graceful shutdown logged"; exit 1; }

echo "OK: image builds, is healthy, runs non-root and shuts down cleanly"
