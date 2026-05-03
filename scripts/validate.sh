#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

python3 -m json.tool manifest.json >/dev/null
node --check background.js
node --check auth.js
node --check codex_bridge.js
node --check vault.js
node --check content.js
node --check sidepanel.js
node --check options.js
python3 -m py_compile native/codex_bridge.py
bash -n scripts/install-native-host.sh

for icon in icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png; do
  test -s "$icon"
done
