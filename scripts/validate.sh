#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

python3 -m json.tool manifest.json >/dev/null
node --check background.js
node --check auth.js
node --check content.js
node --check sidepanel.js
node --check options.js
