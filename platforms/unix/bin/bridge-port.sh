#!/usr/bin/env bash
# Source from Unix launchers before starting any bridge client or server.
# An explicit environment value wins; the profile file is never used as code.
cc_resolve_bridge_port() {
  local file="$1/bridge-port.txt" raw="" extra="" terminated=0 carriage_return=0
  local origin="default" normalized byte_count
  if [[ ${CODEX_COPILOT_BRIDGE_PORT+x} ]]; then
    raw="$CODEX_COPILOT_BRIDGE_PORT"
    origin="environment"
  elif [[ -e "$file" || -L "$file" ]]; then
    origin="profile"
    if [[ ! -f "$file" || -L "$file" ]]; then
      printf 'Invalid bridge port file: expected a regular file in the ccodex profile.\n' >&2
      return 1
    fi
    byte_count="$(wc -c < "$file")"
    if (( byte_count < 4 || byte_count > 32 )); then
      printf 'Invalid bridge port file: unexpected length.\n' >&2
      return 1
    fi
    {
      if IFS= read -r raw; then
        terminated=1
      elif [[ -z "$raw" ]]; then
        printf 'Invalid bridge port file: empty content.\n' >&2
        return 1
      fi
      if IFS= read -r extra || [[ -n "$extra" ]]; then
        printf 'Invalid bridge port file: expected one decimal line only.\n' >&2
        return 1
      fi
    } < "$file"
    if (( terminated )) && [[ "$raw" == *$'\r' ]]; then
      raw="${raw%$'\r'}"
      carriage_return=1
    fi
    if (( byte_count != ${#raw} + terminated + carriage_return )); then
      printf 'Invalid bridge port file: unexpected binary or trailing content.\n' >&2
      return 1
    fi
  else
    raw="22690"
  fi
  if [[ ! "$raw" =~ ^[0123456789]+$ || ${#raw} -gt 16 ]]; then
    printf 'Invalid %s bridge port: expected decimal digits in 1024..65535.\n' "$origin" >&2
    return 1
  fi
  normalized="$raw"
  while [[ ${#normalized} -gt 1 && "$normalized" == 0* ]]; do
    normalized="${normalized#0}"
  done
  if [[ ${#normalized} -gt 5 ]] || (( normalized < 1024 || normalized > 65535 )); then
    printf 'Invalid %s bridge port: expected 1024..65535.\n' "$origin" >&2
    return 1
  fi
  export CODEX_COPILOT_BRIDGE_PORT="$normalized"
}
