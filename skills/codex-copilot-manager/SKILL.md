---
name: codex-copilot-manager
description: >
  Install, migrate, diagnose, repair, and switch accounts for CodexCopilot, which
  runs the native Codex CLI and Windows Codex desktop app with GitHub Copilot
  models through a local bridge. Use for "install CodexCopilot", "move ccodex to
  another machine", "switch the GitHub account used by ccodex", "empty
  models.json", "Codex Copilot bridge failure", or "package CodexCopilot for a
  colleague", as well as "迁移 ccodex", "切换 ccodex 账户", or "修复空模型目录".
  Never transfer credentials or a live .codex-copilot profile.
---

# CodexCopilot Manager

Use this skill for the portable CodexCopilot distribution on Windows.

## Safety rules

- Never copy or share `github-auth.json`, Credential Manager contents, session
  databases, logs, OAuth locks, `.env` files, or MCP secrets.
- Migrate by reinstalling the runtime and authenticating separately on the
  destination machine.
- Stop only the PID returned by the bridge health endpoint. Never kill Node or
  Codex processes by name.
- Preserve the stock `%USERPROFILE%\.codex` profile.

## Diagnose first

```powershell
codex-copilot doctor
codex-copilot status
codex-copilot bridge status
```

If the catalog or generated config is unhealthy:

```powershell
codex-copilot repair
```

Inspect or change the real Copilot context tier with:

```powershell
codex-copilot context
codex-copilot context long_context
```

Tiered models remain a single model. The CLI picker proceeds through
`Model → Context → Effort`, while Desktop shows separate Model, Context, and Reasoning
controls. `context-long` is an internal service-tier value and is removed before the
request is sent to GitHub Copilot.

If credentials are unhealthy or the user wants another account:

```powershell
codex-copilot account switch
```

CLI and Desktop account switching use one bridge-owned device-flow state machine. After
validation, the bridge atomically publishes the credential, catalog and account generation.
Running ccodex sessions use the new account immediately; Desktop restarts its app-server and
reloads so its account, model picker and bottom model bar update together. Desktop users can
initiate the flow from the **GitHub Copilot** profile bar, and GitHub verification opens in
the Windows default browser.

## Install on another machine

Prerequisites are Windows ARM64 or x64 and a GitHub account with Copilot access. Use
the separate `windows-arm64` or `windows-x64` package matching the destination; each
contains only its native Codex and node-pty payload. The installer
attempts to install the official Codex/ChatGPT Store package when it is missing,
then reuses its bundled Codex CLI and Node.js runtime.

From an extracted distribution:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer reuses a valid Copilot credential when available; otherwise it
starts GitHub device login. It creates a separate `.codex-copilot` profile and
does not modify stock Codex authentication.

Upgrade in place by extracting the newer bundle and running `install.ps1` again.
Do not uninstall first; the isolated profile, account and model settings are preserved.

## Create a colleague-safe transfer bundle

```powershell
codex-copilot export .\codex-copilot-transfer.zip
```

The destination user extracts the zip, runs `install.ps1`, and authenticates
their own account. Do not add profile data to the zip.

## Verify

```powershell
codex-copilot doctor
codex-copilot models
ccodex exec --skip-git-repo-check "Reply exactly OK"
```

Launch **Codex (Copilot)** from the Start menu and confirm the selected model is
present. Treat a successful CLI call and a non-empty model catalog as required
before declaring the migration complete.
