// Read-only P1 audit. The shared checkout cannot be staged as a publication
// candidate; use the existing audit implementation on an explicit task scope.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { auditSourceFiles } from "./check-source-publication.mjs";
export const spineSourceFiles = [
  "gateway/spine/contracts.mts", "gateway/spine/storage.mts", "gateway/spine/compressor.mts", "gateway/spine/registry.mts", "gateway/spine/mcp-server.mts", "gateway/spine/native-config.mts", "gateway/spine/command-shim.mts",
  "gateway/contracts.mts", "gateway/server.mts", "gateway/native-peer.mts", "gateway/routed-stdio.mts",
  "bridge/diy/drawer.mts", "bridge/desktop-spine-ui.mts", "bridge/desktop-diy-contracts.mts", "bridge/desktop-gateway-ui.mts", "bridge/desktop-current-host-contract.mjs", "bridge/desktop-mode.mjs", "bridge/desktop-backends/app-server-gateway.mjs",
  "bridge/desktop-protected-start.mts", "bridge/desktop-current-host.mjs", "bridge/desktop-shortcut.mjs", "tests/desktop-protected-start-test.mjs", "tests/desktop-shortcut-test.mjs",
  "tests/spine-compressor-test.mjs", "tests/spine-registry-test.mjs", "tests/spine-mcp-test.mjs", "tests/spine-drawer-test.mjs", "tests/types/spine-contracts.mts", "tests/typescript-build-test.mjs",
  "tools/typescript-task.mjs", "tools/check-spine-source.mjs", ".gitignore", "docs/architecture/0018-spine-p1.zh-CN.md",
  "docs/architecture/evidence/2026-10-31-spine-p1.json",
];
export function auditSpineSource(root = path.resolve(import.meta.dirname, "..")) {
  const result = auditSourceFiles(root, spineSourceFiles);
  const pureView = fs.readFileSync(path.join(root, "bridge/diy/drawer.mts"), "utf8");
  if (/node:|\bprocess\.|\brequire\(|\b(?:VUn|eLt)\b|[Rr]eact[Ff]iber|app:\/\//.test(pureView)) { result.passed = false; result.findings.push({ file: "bridge/diy/drawer.mts", issue: "host or Node dependency in pure view" }); }
  return { scope: "P1 explicit source files; shared checkout not staged or published", ...result };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = auditSpineSource();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.passed) process.exitCode = 1;
}
