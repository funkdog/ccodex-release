#!/usr/bin/env bash
set -euo pipefail

# Called from Publish-Release.ps1 under the machine's global heavy-build lock.
[[ "${CARGO_BUILD_JOBS:-}" == 6 ]] || {
  echo "Use run-heavy-build.ps1 before packaging Unix targets." >&2
  exit 1
}
stage="$1"
previous_dist="$2"
output="$3"
previous_version="$4"
candidate_root="${5:-}"
bootstrap="$(mktemp -d /tmp/ccodex-release-node.XXXXXXXX)"
cleanup() {
  [[ "$bootstrap" == /tmp/ccodex-release-node.* && ! -L "$bootstrap" ]] || {
    echo "Refusing unexpected bootstrap cleanup target." >&2
    return 1
  }
  rm -rf -- "$bootstrap"
}
trap cleanup EXIT

base="codex-copilot-linux-arm64-$previous_version"
tar -xzf "$previous_dist/$base.tar.gz" -C "$bootstrap" "$base/runtime/node/bin/node"
node="$bootstrap/$base/runtime/node/bin/node"
[[ -x "$node" ]] || { echo "Previous release has no Linux ARM64 Node runtime." >&2; exit 1; }

for target in linux-arm64 linux-x64 macos-arm64 macos-x64; do
  arguments=(--target "$target" --previous-version "$previous_version"
    --previous-dist "$previous_dist" --output-dir "$output")
  if [[ -n "$candidate_root" ]]; then arguments+=(--candidate-root "$candidate_root"); fi
  nice -n 10 "$node" "$stage/tools/repackage-unix.mjs" "${arguments[@]}"
done
