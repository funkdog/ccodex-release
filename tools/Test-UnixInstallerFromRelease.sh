#!/usr/bin/env bash
set -euo pipefail

# Run under run-heavy-build.ps1. The prior Linux ARM64 release supplies Node;
# the test itself uses only isolated profiles and fake prerequisites.
[[ "${CARGO_BUILD_JOBS:-}" == 6 ]] || {
  echo "Run Unix release tests through the six-job heavy-build wrapper." >&2
  exit 1
}
stage="$1"
prior_dist="$2"
prior_version="$3"
report="$4"
temporary="$(mktemp -d /tmp/ccodex-unix-tests.XXXXXXXX)"
cleanup() {
  [[ "$temporary" == /tmp/ccodex-unix-tests.* && ! -L "$temporary" &&
    "$(realpath "$temporary")" == "$temporary" ]] || {
    echo "Refusing unexpected Unix test cleanup target." >&2
    return 1
  }
  rm -rf -- "$temporary"
}
trap cleanup EXIT

base="codex-copilot-linux-arm64-$prior_version"
archive="$prior_dist/$base.tar.gz"
read -r expected_hash expected_name < "$archive.sha256"
[[ "$expected_hash" =~ ^[[:xdigit:]]{64}$ && "$expected_name" == "$base.tar.gz" ]] || {
  echo "Prior Linux runtime archive checksum metadata is invalid." >&2
  exit 1
}
actual_hash="$(sha256sum "$archive" | cut -d ' ' -f 1)"
[[ "${expected_hash,,}" == "$actual_hash" ]] || {
  echo "Prior Linux runtime archive checksum does not match; no runtime was executed." >&2
  exit 1
}
tar -xzf "$archive" -C "$temporary" "$base/runtime/node/bin/node"
node="$temporary/$base/runtime/node/bin/node"
[[ -x "$node" ]] || { echo "Prior release has no Linux ARM64 Node runtime." >&2; exit 1; }
mkdir -p "$temporary/home"
export HOME="$temporary/home" TMPDIR="$temporary" CODEX_HOME="$temporary/profile"
export CODEX_COPILOT_HOME="$temporary/profile" CARGO_BUILD_JOBS=6
nice -n 10 "$node" --test --test-concurrency=6 --test-reporter=tap \
  "$stage/tests/unix-installer-test.mjs" "$stage/tests/unix-bridge-port-test.mjs" |
  tee "$report"

count() {
  awk -v field="$1" '$1=="#" && $2==field { print $3 }' "$report" | tail -n 1
}
tests="$(count tests)"
pass="$(count pass)"
fail="$(count fail)"
skipped="$(count skipped)"
cancelled="$(count cancelled)"
[[ "$tests" -ge 14 && "$pass" == "$tests" &&
  "$fail" == 0 && "$skipped" == 0 && "$cancelled" == 0 ]] || {
  echo "Unix installer suite is incomplete: tests=$tests pass=$pass fail=$fail skipped=$skipped cancelled=$cancelled" >&2
  exit 1
}
printf 'Unix installer suite verified: %s passed, zero skipped.\n' "$pass"
