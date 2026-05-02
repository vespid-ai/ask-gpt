#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${ASK_GPT_PROFILE:-/tmp/ask-gpt-chromium-profile}"
PORT="${ASK_GPT_DEBUG_PORT:-9227}"

open -na "Chromium" --args \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --remote-debugging-port="$PORT" \
  --disable-extensions-except="$ROOT" \
  --load-extension="$ROOT" \
  "${1:-https://example.com}"
