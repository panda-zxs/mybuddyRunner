#!/usr/bin/env bash
set -euo pipefail
cd "$SOURCE_DIR"
heartbeat() {
  while sleep 60 >/dev/null 2>&1; do
    echo "Core verification active: $(date -u '+%H:%M:%S UTC')"
    ps -eo pid,ppid,pcpu,rss,comm | awk 'NR == 1 || /rustc|cargo|clippy/' || true
  done
}
heartbeat &
heartbeat_pid=$!
trap 'kill "$heartbeat_pid" 2>/dev/null || true' EXIT
stage() {
  local label="$1"
  shift
  echo "::group::$label"
  local started=$SECONDS
  local status=0
  "$@" || status=$?
  echo "$label: $((SECONDS - started))s, exit=$status"
  echo "::endgroup::"
  return "$status"
}
stage 'Core format' cargo fmt --all -- --check
stage 'Core Clippy' cargo clippy --workspace --locked -- -D warnings
stage 'Core workspace tests' cargo test --workspace --locked
