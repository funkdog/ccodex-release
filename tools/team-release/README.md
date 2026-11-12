# Windows offline installer sources

These files implement the published native self-extracting installer:

- `setup-arm64.c` / `setup-x64.c`: architecture-specific native bootstrap.
- `setup-*.manifest`: Windows process manifests.
- `setup-bootstrap.ps1`: verified staging, safe ZIP paths and private installer handoff.
- `package-setup.mjs`: inventory verification, ZIP assembly and SHA256-bound SFX footer.
- `zip-payload.py` / `verify-zip.py`: complete offline payload packing and per-resource verification.
- `repack-payload.py`: rebuilding an existing verified payload without replacing fixed runtime bytes.

The frozen stage, compiled bootstrap and vendor resources are build inputs, not
checked-in source. A stage must already contain matching `release.json` and
`release-files.json`, all fixed resources, compiled native helper components and
the complete private runtime. Do not point these tools at a live user profile.

From this repository, with those inputs prepared:

```powershell
node tools/team-release/package-setup.mjs dist/Setup.exe `
  --stage=D:/Build/frozen-stage `
  --stub=D:/Build/setup-arm64.exe `
  --zip=D:/Build/payload.zip `
  --reuse-inventory
```

Pass `--assembled-zip` only for an already complete ZIP; it is still decompressed
and checked resource by resource. Use the repository heavy-task scheduler for
real compilation, full tests and package assembly.

An explicitly frozen stage with `--reuse-inventory` is mandatory; the tool
does not import a live installation or profile to fill in missing inputs.
Changing native helper sources requires recompiling those components before
freezing a stage. Changing the Codex patch chain requires matching native core
and companion builds, not just a new manifest.

Same-version UI replacements reuse the verified native bootstrap and fixed
vendor resources, update the frozen first-party files and verify every compressed
resource again. They have new installer digests, not a new public version.
They do not claim a newly reproduced or newly authorized vendor resource bundle.
