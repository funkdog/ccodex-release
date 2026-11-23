# MyCodex

[![MIT License](https://img.shields.io/badge/license-MIT-2563eb)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853d)](https://nodejs.org/)
[![MyCodex 0.2.0-rc.1 for macOS ARM64](https://img.shields.io/badge/macOS_ARM64-MyCodex_0.2.0--rc.1-b45309)](https://github.com/funkdog/ccodex-release/releases/tag/mycodex-v0.2.0-rc.1)
[![LINUX DO](https://img.shields.io/badge/LINUX-DO-FFB003.svg?logo=data:image/svg%2bxml;base64,DQo8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMDAiPjxwYXRoIGQ9Ik00Ni44Mi0uMDU1aDYuMjVxMjMuOTY5IDIuMDYyIDM4IDIxLjQyNmM1LjI1OCA3LjY3NiA4LjIxNSAxNi4xNTYgOC44NzUgMjUuNDV2Ni4yNXEtMi4wNjQgMjMuOTY4LTIxLjQzIDM4LTExLjUxMiA3Ljg4NS0yNS40NDUgOC44NzRoLTYuMjVxLTIzLjk3LTIuMDY0LTM4LjAwNC0yMS40M1EuOTcxIDY3LjA1Ni0uMDU0IDUzLjE4di02LjQ3M0MxLjM2MiAzMC43ODEgOC41MDMgMTguMTQ4IDIxLjM3IDguODE3IDI5LjA0NyAzLjU2MiAzNy41MjcuNjA0IDQ2LjgyMS0uMDU2IiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZWNlY2VjO2ZpbGwtb3BhY2l0eToxIi8+PHBhdGggZD0iTTQ3LjI2NiAyLjk1N3EyMi41My0uNjUgMzcuNzc3IDE1LjczOGE0OS43IDQ5LjcgMCAwIDEgNi44NjcgMTAuMTU3cS00MS45NjQuMjIyLTgzLjkzIDAgOS43NS0xOC42MTYgMzAuMDI0LTI0LjM4N2E2MSA2MSAwIDAgMSA5LjI2Mi0xLjUwOCIgc3R5bGU9InN0cm9rZTpub25lO2ZpbGwtcnVsZTpldmVub2RkO2ZpbGw6IzE5MTkxOTtmaWxsLW9wYWNpdHk6MSIvPjxwYXRoIGQ9Ik03Ljk4IDcwLjkyNmMyNy45NzctLjAzNSA1NS45NTQgMCA4My45My4xMTNRODMuNDI2IDg3LjQ3MyA2Ni4xMyA5NC4wODZxLTE4LjgxIDYuNTQ0LTM2LjgzMi0xLjg5OC0xNC4yMDMtNy4wOS0yMS4zMTctMjEuMjYyIiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZjlhZjAwO2ZpbGwtb3BhY2l0eToxIi8+PC9zdmc+)](https://linux.do)

[中文](README.md) · English

**Set direction in one conversation. Ship in parallel from separate worktrees.**

## What is MyCodex?

MyCodex adds a local multi-engine gateway and multi-agent collaboration to compatible **official Codex / ChatGPT desktop clients**. You work in the familiar desktop window with its native chat stream, project file tree, integrated terminal, and controls.

- **Multi-Engine Gateway.** Connect official Codex, GitHub Copilot (API / CLI), Claude Code, and supported Antigravity / Gemini runtimes from one window using your own accounts and subscriptions. Choose a configured engine and model when starting a new chat. In an existing chat, switch among compatible models from the same engine and model source. A Squad can use different configured models by role, for example one for implementation and another for an independent review. [Engine and model selection rules](docs/architecture/0031-model-sources-and-handoff.zh-CN.md)
- **MyCodex Squad in the native split pane.** Use one main conversation on the left to set direction, agree on acceptance criteria, and make decisions. Keep `Squad Studio` docked on the right to inspect member worktrees, branches, rounds, Git diffs, and read-only artifact previews. Members can pick up where they left off or start fresh for a read-only review. Move a persistent member to the sidebar when you want to talk with it directly.

![MyCodex: Official Codex Desktop + Multi-Engine Gateway + Squad Studio](docs/assets/mycodex-squad-overview.png)

## A Practical Paradigm: Core Trade-offs & Taste

MyCodex Squad is not meant as the only multi-agent paradigm—it is a practical workflow we found effective for complex software engineering and multi-stage creative production. Researchers at UC Berkeley used MAST to analyze 1,642 execution traces across specification, coordination, and verification failures; Anthropic's Research system isolates noisy sub-explorations in separate context windows; and Cognition's Devin team highlighted how code edits carry implicit decisions and how clean-context diff reviews catch author blind spots. [MAST paper](https://openreview.net/attachment?id=fAjbYBmonr&name=pdf) · [Anthropic's Research system](https://www.anthropic.com/research/multi-agent-research-system) · [Cognition's multi-agent experiments](https://cognition.com/blog/multi-agents-working)

1. **Split work at context boundaries and keep memory local to the module.** Give modules that require extensive code reading and test runs their own slots. A `stateful` implementer continues the same conversation across rounds, retaining what it learned about interfaces, constraints, and earlier investigations. Shared goals and agreements stay in the main conversation.
2. **Review from a fresh, read-only context.** A `clean` + `readOnly` reviewer starts a new conversation with the acceptance criteria, actual diff, and relevant original material. The implementer's conversation history stays in its own slot, and the reviewer can trace findings back to code and tests.
3. **Isolate worktrees across repositories and hand off material by reference.** Writing slots can bind to different repositories and use their own Git worktrees. `touches` declares write scope and `forbid` carries prohibited paths across rounds by default. Pass original material through `inputs` and consult sibling worktrees as read-only references. The kernel records branches, commits, and changes from Git and checks write boundaries before integration.
4. **Give `STATE` one writer and let the kernel check execution state.** The main conversation maintains the live plan with plain-language outcomes and falsifiable technical criteria. `quiescent` means execution has settled. A receipt marked `escalate` requests a human decision. The main conversation assesses acceptance from the evidence, and people decide the gates that require their judgment.
5. **Expose assumptions at handoff and interrupt for decisions.** Members include `Assumptions & Trade-offs` in their receipts. The main conversation can use a technical review card to highlight design, performance, and risk choices. `Needs You` takes up zero space when clear. Inline cards and chat replies update the same gate state.

## Architecture

```mermaid
flowchart LR
  subgraph Desktop["Compatible ChatGPT / Codex desktop client"]
    direction TB
    Main["Main chat · goals, criteria, decision cards"]
    Studio["Squad Studio · rounds, diffs, artifacts"]
  end
  Main -->|"MCP · init, dispatch, integrate"| Squad["Squad V2 kernel"]
  Studio -->|"Observe and resolve gates"| Squad
  Squad --> State["STATE · criteria and gates"]
  Squad --> ImplA["Stateful implementer · repo A / own worktree"]
  Squad --> ImplB["Stateful implementer · repo B / own worktree"]
  Squad --> Review["Clean reviewer · read-only"]
  ImplA --> Git["Branches, commits, changes"]
  ImplB --> Git
  Git -.->|"Actual diff and read-only references"| Review
  Git --> Squad
  Main --> Gateway["Local Gateway"]
  Squad --> Gateway
  Gateway --> Engines["Official Codex · Copilot · Claude Code · Antigravity / Gemini"]
```

### Squad MCP tools

The table uses the registered MCP names. A host may render the dot as an underscore. The main conversation uses the control tools. Members receive scoped briefs and references to the original material.

| Tool | Responsibility |
| --- | --- |
| `mycodex.squad_init` | Initialize or resume the Squad for the main conversation and return its Studio entry. |
| `mycodex.squad_state` | Use the current `expectedRevision` to update the plan, record acceptance, or resolve a gate. |
| `mycodex.squad_dispatch` | Dispatch a round asynchronously with a context mode, repository, write boundaries, and source references. |
| `mycodex.squad_status` | Read the Studio snapshot for activity, delivery receipts, and acceptance status. |
| `mycodex.show_squad_card` | Present a gate or a curated technical review in the conversation. The presentation is read-only. |
| `mycodex.squad_integrate` | Merge a quiescent role worktree after checking its write boundaries and record acceptance for the round. |
| `mycodex.squad_close` | Close a standing Squad at the user's request, preserving chats and optionally promoting persistent members. |

[Tool registration and parameter schemas](gateway/spine/squad-commands.mts)

## Quick Start

### Build and verify from source

Install Git, Node.js 24 or later, and npm. These commands use a macOS or Linux shell. On Windows, use the same npm scripts and `tools/Invoke-HeavyTask.ps1` for manual heavy tasks.

```bash
git clone https://github.com/funkdog/ccodex-release.git
cd ccodex-release
npm ci
npm run typecheck
npm run build
npm run check:generated
bash tools/Invoke-HeavyTask.sh node --test tests/squad-protocol-test.mjs tests/squad-lifecycle-test.mjs
```

After building on macOS, you can launch a compatible official desktop client against your local source build to enable the full gateway and Squad Studio (see [`platforms/macos/`](platforms/macos/) and [`docs/DEVELOPMENT.zh-CN.md`](docs/DEVELOPMENT.zh-CN.md)). Browser tests need Playwright and a Chromium browser; see the [contribution guide](CONTRIBUTING.md) for source entry points, isolated test setup, and broader checks.

### Try the macOS prerelease

[Download MyCodex 0.2.0-rc.1](https://github.com/funkdog/ccodex-release/releases/tag/mycodex-v0.2.0-rc.1). Verify the **macOS Apple Silicon (ARM64)** archive’s SHA-256, extract it, and run `./Install.command` and `./Diagnose.command`. Once active tasks have finished, quit the official client normally and run `./Start.command`. Native Codex, the `mycodex` MCP server, and the right-hand `Squad Studio` are enabled by default.

- [macOS installation and compatible host versions](docs/ADAPTERS-MACOS.zh-CN.md) (Chinese)
- [Connect your own GitHub Copilot account and select a model](docs/CODEX-COPILOT-SETUP.zh-CN.md) (Chinese)
- [0.2.0-rc.1 release and verification](docs/releases/mycodex-0.2.0-rc.1.md) · [GitHub Copilot setup](docs/CODEX-COPILOT-SETUP.zh-CN.md) (Chinese)

Use the setup wizard to add Claude Code or Antigravity ACP 1.4.4. Follow the linked setup guide for GitHub Copilot.

## Repository Guide

| Path | Contents |
| --- | --- |
| [`gateway/`](gateway/) | App Server routing, session protocol, and engine adapters |
| [`gateway/spine/`](gateway/spine/) | Squad V2 kernel, MCP, state, and worktree checks |
| [`bridge/`](bridge/) | Response translation, desktop host integration, and [Squad Studio and inline cards](bridge/diy/) |
| [`tests/`](tests/) · [`tools/`](tools/) | Regression tests, build tools, source audit, and verification |
| [`docs/`](docs/) · [`release/`](release/) | Design notes, user guides, and release provenance |

- [ADR 0034 · Squad V2 architecture](docs/architecture/0034-squad-v2-architecture.zh-CN.md) (Chinese)
- [ADR 0035 · Squad V2 retrospective](docs/architecture/0035-squad-v2-retrospective-and-closeout.zh-CN.md) (Chinese)
- [Squad Studio visual specification](docs/design/squad-visual-spec.md) · [Engine and native display contracts](docs/architecture/0032-heterogeneous-model-and-display-standard.zh-CN.md) (Chinese)

## Acknowledgments

- Thanks to the **[LINUX DO](https://linux.do)** developer community for open-source discussion and feedback.
- Thanks to **troupe** for its single-orchestrator workflow, up-front approval of acceptance criteria, per-role Git worktrees, and independent branch review before integration. [troupe](https://github.com/hitianqi/troupe)
- Thanks to **bothouse** for showing how to team up local CLIs such as Claude Code, Codex, and Gemini, preserve the user's original wording in handoffs, and add a second check from a clean context. [bothouse](https://github.com/zuiho-kai/bothouse)
- Thanks to the UC Berkeley MAST researchers, Anthropic's engineering team, and Cognition's Devin team for publishing their findings on multi-agent failures, context separation, and independent review. [MAST](https://openreview.net/attachment?id=fAjbYBmonr&name=pdf) · [Anthropic](https://www.anthropic.com/research/multi-agent-research-system) · [Cognition](https://cognition.com/blog/multi-agents-working)

## License

The first-party gateway, bridge, and Squad source are available under the [MIT License](LICENSE). Third-party components retain their own terms. Users manage third-party private runtime binaries and personal credentials separately from this source repository.
