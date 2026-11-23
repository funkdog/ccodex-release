#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
root="$PWD"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo '当前候选版仅验证 macOS Apple Silicon（ARM64）。'; exit 1; }
node_path="$(command -v node || true)"
if [[ -z "$node_path" ]]; then
  echo '请先从 https://nodejs.org/ 安装 Node.js 24 LTS，重新打开终端后重试。'
  exit 1
fi
"$node_path" -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("需要 Node.js 24 或更新版本。"); process.exit(1); }'
case "$(basename -- "$0")" in
  Install.command|Configure.command) operation=configure;;
  Diagnose.command) operation=models;;
  Start.command) operation=start;;
  Install-Launcher.command)
    exec bash "$root/tools/Invoke-HeavyTask.sh" "$node_path" "$root/tools/configure-adapters.mjs" install-launcher "$@";;
  *) echo '请通过包内的 Install / Configure / Diagnose / Start.command 使用。'; exit 1;;
esac
exec "$node_path" "$root/tools/configure-adapters.mjs" "$operation" "$@"
