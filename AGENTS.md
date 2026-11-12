# CodexCopilot release invariant

This directory is the canonical package source. The installed copy under
`%LOCALAPPDATA%\CodexCopilot` and the archives under `dist` are outputs, not
places to make untracked feature fixes.

For every request that fixes or updates ccodex or its Desktop integration:

1. Inspect the installed `bin/core-current.txt`, running processes, source
   `VERSION`, release manifests and dirty source state. Preserve active user
   sessions and unrelated files.
2. Change source and tests here. If the native Codex core changes, update
   `NATIVE_PATCH_CHAIN.json`, apply the chain to the pinned upstream revision
   and build/test six candidate cores in order: Windows ARM64, Windows x64,
   Linux ARM64, Linux x64, macOS ARM64, macOS x64. Never reuse an old core
   when the native patch tree changed.
3. Without waiting for an additional user instruction, publish a functional
   change by invoking `tools/Publish-Release.ps1` through the repository-local
   `tools/Invoke-HeavyTask.ps1`. It runs isolated package/native
   tests and builds/verifies all matching platform archives. The wrapper owns
   the global build lock, six-job limit and BelowNormal priority. Never call
   `cargo build`, `cargo test`, `just test`, `ninja`, `msbuild`,
   `Compress-Archive` or a full `node --test` outside that wrapper.
4. Inspect `dist/RELEASE-MANIFEST-<version>.json` and
   `dist/RELEASE-TESTS-<version>.json`, verify installed source/core hashes
   against the promoted release, and run the relevant live CLI/Desktop
   interaction checks. Use only isolated temporary profiles for automated
   tests. Confirm build descendants exited and remove owned temporary build
   sources, targets and intermediate archives after completion.
5. Do not describe a source edit, a green unit test, or an unverified archive
   as a published release. If a platform runner, Desktop authorization, live
   browser session, or test prerequisite is unavailable, report the exact
   missing evidence and keep the larger goal active.

Documentation/source-publication-only changes do not rebuild or replace the
already verified installers. Do not increase VERSION or run a six-platform
build for repository housekeeping. See docs/DEVELOPMENT.zh-CN.md for the
source/runtime boundary and docs/RELEASE.zh-CN.md for the fixed Windows release.
Do not commit credentials, profiles, third-party runtime copies or build output.
CI templates live in ci/ and are not activated automatically by source uploads.

The optional `CODEX_COPILOT_SHOWCASE_URL` must be an explicitly configured,
trusted HTTPS JSON endpoint. Do not invent a release URL or execute remote
showcase content as code. A package snapshot is the offline fallback, not a
claim that old packages can update themselves without this mechanism.
