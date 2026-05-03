#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  cat >&2 <<'EOF'
Usage: scripts/install-native-host.sh <chrome-extension-id> [chrome|chromium|edge|brave]

Find the extension id on chrome://extensions after loading this repo unpacked.
EOF
  exit 2
fi

EXTENSION_ID="$1"
BROWSER="${2:-chrome}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_SCRIPT="$ROOT/native/codex_bridge.py"
HOST_NAME="com.ask_gpt.codex_bridge"

case "$BROWSER" in
  chrome)
    HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  chromium)
    HOST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    ;;
  edge)
    HOST_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    ;;
  brave)
    HOST_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    ;;
  *)
    echo "Unsupported browser: $BROWSER" >&2
    exit 2
    ;;
esac

if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Chrome extension id should be 32 lowercase letters from a-p." >&2
  exit 2
fi

mkdir -p "$HOST_DIR"
chmod +x "$HOST_SCRIPT"

cat > "$HOST_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Ask GPT local Codex bridge",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Installed native host:"
echo "$HOST_DIR/$HOST_NAME.json"
