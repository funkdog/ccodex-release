#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x "$root/../../bin/codex-copilot" ]]; then
  exec "$root/../../bin/codex-copilot" history ui --open "$@"
fi
export HISTORY_DEFAULT_PRODUCT=copilot
exec node "$root/cli.mjs" ui --open "$@"
