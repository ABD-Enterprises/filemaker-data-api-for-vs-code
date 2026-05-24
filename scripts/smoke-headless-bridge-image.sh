#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:-filemaker-bridge:smoke}"
CONTAINER_ID=""
TMP_DIR="$(mktemp -d)"

cleanup() {
  if [[ -n "$CONTAINER_ID" ]]; then
    docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

printf 'smoke-password\n' >"$TMP_DIR/fm-password"
chmod 755 "$TMP_DIR"
chmod 0444 "$TMP_DIR/fm-password"

docker build -t "$IMAGE" "$ROOT"

CONTAINER_ID="$(
  docker run -d --rm \
    -e BRIDGE_PORT=8080 \
    -e BRIDGE_TOKEN=smoke-token \
    -e FM_SERVER=https://filemaker.example.test \
    -e FM_DATABASE=SmokeDB \
    -e FM_USER=smoke-user \
    -e FM_PASS_FILE=/run/secrets/fm-password \
    -v "$TMP_DIR/fm-password:/run/secrets/fm-password:ro" \
    -p 127.0.0.1::8080 \
    "$IMAGE"
)"

HOST_PORT="$(docker port "$CONTAINER_ID" 8080/tcp | sed 's/.*://')"

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null; then
    echo "Headless bridge image smoke test passed."
    exit 0
  fi
  sleep 1
done

docker logs "$CONTAINER_ID" >&2 || true
echo "Headless bridge image smoke test failed." >&2
exit 1
