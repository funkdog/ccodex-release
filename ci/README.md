# Build workflow templates

The existing multi-platform build workflow is kept as source in
`ci/build-platform-packages.yml`. It is intentionally not activated by source
or documentation uploads. Copy it into `.github/workflows/` only after reviewing
runner prerequisites, resource provenance and GitHub workflow authorization.

The source repository does not contain the closed-source Desktop snapshot or
offline vendor runtimes. GitHub's automatically generated source archives are
not installer packages. See `docs/DEVELOPMENT.zh-CN.md`.
