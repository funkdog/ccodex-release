#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  printf 'A heavy task command is required.\n' >&2
  exit 2
fi
export CARGO_BUILD_JOBS=6 CMAKE_BUILD_PARALLEL_LEVEL=6 MAX_JOBS=6
export npm_config_jobs=6 RUST_TEST_THREADS=6 MAKEFLAGS=-j6 GOMAXPROCS=6

# A host scheduler already holding the global lock passes this explicit marker.
if [[ "${CODEX_COPILOT_HEAVY_LOCK_HELD:-0}" == "1" ]]; then
  exec nice -n 10 "$@"
fi
export CODEX_COPILOT_HEAVY_LOCK_HELD=1

cache="${XDG_CACHE_HOME:-$HOME/.cache}/codex-copilot"
mkdir -p "$cache"
[[ ! -L "$cache" ]] || { printf 'Heavy-task cache cannot be linked.\n' >&2; exit 1; }
lock="$cache/heavy-task.lock"
[[ ! -L "$lock" ]] || { printf 'Heavy-task lock cannot be linked.\n' >&2; exit 1; }
if command -v flock >/dev/null 2>&1; then
  exec flock --exclusive "$lock" nice -n 10 "$@"
fi
if [[ "$(uname -s)" == "Darwin" ]] && command -v python3 >/dev/null 2>&1; then
  exec python3 -c '
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
os.set_inheritable(fd, True)
os.nice(10)
os.execvp(sys.argv[2], sys.argv[2:])
' "$lock" "$@"
fi
printf 'flock is required for independently scheduled Unix heavy tasks. No task was started.\n' >&2
exit 1
