import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { auditSourceFiles } from "./check-source-publication.mjs";
import { spineSourceFiles } from "./check-spine-source.mjs";
export const p2SourceFiles = [...new Set([...spineSourceFiles,
  "gateway/media.mts", "gateway/input.mts", "gateway/protocol.mts", "gateway/router.mts", "gateway/ipc.mts", "gateway/acp-peer.mts",
  "gateway/engines/antigravity.mts", "gateway/engines/gemini-cli.mts", "gateway/engines/github-copilot.mts", "gateway/engines/claude-code.mts",
  "gateway/spine/config.mts", "gateway/spine/io.mts", "gateway/spine/schema.mts", "gateway/spine/kernel.mts", "gateway/spine/trace.mts", "gateway/spine/trace-peer.mts", "gateway/spine/radar.mts", "gateway/spine/daily.mts", "gateway/spine/knowledge.mts", "gateway/spine/knowledge-contracts.mts", "gateway/spine/schemas/mycodex-knowledge-card.schema.json",
  "bridge/diy/radar-panel.mts", "bridge/diy/daily-panel.mts", "bridge/diy/workbench.mts",
  "tests/gateway-media-test.mjs", "tests/spine-p2-test.mjs", "tests/spine-p2-ui-test.mjs", "tests/spine-native-tap-test.mjs", "tests/types/spine-p2-contracts.mts", "tests/fixtures/antigravity-acp.mjs", "tests/fixtures/gemini-acp.mjs", "tools/typescript-state.mjs", "tools/check-spine-p2-source.mjs", "docs/architecture/0020-spine-p2.zh-CN.md", "docs/architecture/evidence/2026-11-02-spine-p2.json",
])];
export function auditP2(root = path.resolve(import.meta.dirname, "..")) {
  const result = auditSourceFiles(root, p2SourceFiles);
  for (const file of p2SourceFiles.filter(file => file.startsWith("bridge/diy/") && file.endsWith(".mts"))) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    if (/node:|\bprocess\.|\brequire\(|\b(?:VUn|eLt)\b|[Rr]eact[Ff]iber|app:\/\/|\/Users\//.test(source)) { result.passed = false; result.findings.push({ file, issue: "host/private-runtime dependency in pure DIY view" }); }
  }
  return { scope: "explicit P1 foundation and P2 task files; shared checkout not staged/published", ...result };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) { const result = auditP2(); console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1; }
