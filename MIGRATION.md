# Account and machine migration

CodexCopilot is migrated by reinstalling the runtime and authenticating on the
destination. Do not copy the live `%USERPROFILE%\.codex-copilot` directory.

## Switch GitHub accounts on the same machine

```powershell
codex-copilot account switch
codex-copilot status
codex-copilot models
```

`account switch` is owned by the running bridge. After validation, the bridge atomically
publishes the credential, catalog and account generation. Running ccodex sessions immediately
use the new bridge account; Desktop restarts its local app-server and reloads so its native
profile/model surfaces update together. GitHub verification opens in the system browser.

Model, context and reasoning use a second generation-stamped state shared by ccodex and
Desktop. Changes take effect on the next request without interrupting an in-flight turn.
`codex-copilot verify` proves the effective upstream model, context limit and serialized effort
while redacting prompt/tool/image content and credentials. The GitHub Copilot CLI and
ClaudeCopilot profiles remain isolated.

## Move to another machine

On the source machine:

Windows:

```powershell
codex-copilot export .\codex-copilot-transfer.zip
```

macOS/Linux:

```bash
codex-copilot export ./codex-copilot-transfer.tar.gz
```

Windows exports a `.zip`; macOS and Linux export a `.tar.gz`. The bundle contains the
installer/runtime for the current OS and CPU plus the preferred model, reasoning effort,
and context tier. It does not contain
OAuth tokens, OS keychain records, sessions, request-audit/bridge logs, databases, MCP secrets,
named-pipe paths, or the live Codex profile.

On the destination machine:

1. Use the same target as the destination:
   `windows-arm64`/`windows-x64`, `macos-arm64`/`macos-x64`, or
   `linux-arm64`/`linux-x64`. These are intentionally separate packages; credentials
   must never be moved between them.
2. On Windows, double-click `install.cmd`, or run:

   ```powershell
   .\install.ps1
   ```

   If the official Codex/ChatGPT desktop package is missing, the installer attempts to install
   Microsoft Store product `9PLM9XGG6VKS` through `winget`. Its bundled Codex CLI and Node.js
   runtime are reused automatically.

   On macOS or Linux, extract the target `.tar.gz` and run:

   ```bash
   ./install.sh
   ```

   macOS Desktop support requires an existing official `Codex.app`. Linux is CLI-only.

3. Complete GitHub device login if no usable Copilot credential already exists.
4. Verify:

   ```text
   codex-copilot doctor
   ccodex exec --skip-git-repo-check "Reply exactly OK"
   ```

## Upgrade an existing installation

Do not uninstall first. Install the newer package for the same OS and CPU over the existing
installation. The isolated profile, account, and model/Context/effort selections are preserved.

## Security boundary

Authentication is always established independently on the destination machine.
Never send these files to another person:

- `%USERPROFILE%\.codex-copilot\github-auth.json`
- Windows Credential Manager exports
- `%USERPROFILE%\.codex-copilot` databases, sessions, logs, or OAuth locks
- `.env` files or MCP configuration containing secrets

The generated Copilot profile inherits the destination machine's stock
`%USERPROFILE%\.codex\config.toml`, so local paths and installed plugins are
resolved for that machine rather than copied from the source.
