import { assertTypeScriptBuild } from "./typescript-state.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
assertTypeScriptBuild(root);
const requested = process.argv[2];
const output = path.resolve(
  requested ||
    path.join(
      process.cwd(),
      `codex-copilot-transfer-${new Date().toISOString().slice(0, 10)}.tar.gz`,
    ),
);
if (!output.endsWith(".tar.gz")) {
  throw new Error("Unix transfer bundle output must end in .tar.gz");
}
if (fs.existsSync(output) && !process.argv.includes("--force")) {
  throw new Error(`Output already exists: ${output}. Use --force to replace it.`);
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "codex-copilot-transfer-"));
const payload = path.join(staging, "codex-copilot-portable");
const allowed = [
  "package.json", "package-lock.json", "tsconfig.json",
  "README.md",
  "WORKIQ.md",
  "NATIVE_COMPATIBILITY.md",
  "MIGRATION.md",
  "MIGRATION.zh-CN.md",
  "VERSION",
  "NATIVE_PATCH_CHAIN.json",
  "platform-target.json",
  "install.sh",
  "assets",
  "bin",
  "bridge", "gateway",
  "patches",
  "skills",
  "tools",
  "runtime",
];
const textExtensions = new Set([
  ".swift",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".map",
  ".sh",
  ".toml",
  ".txt",
]);
const tokenPattern =
  /gh(?:o|u|p)_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/;

try {
  fs.mkdirSync(payload, { recursive: true });
  for (const item of allowed) {
    const source = path.join(root, item);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(payload, item), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }

  const home =
    process.env.CODEX_COPILOT_HOME ||
    path.join(os.homedir(), ".codex-copilot");
  let defaultModel = null;
  let defaultReasoningEffort = null;
  let defaultContextTier = null;
  try {
    const selection = JSON.parse(
      fs.readFileSync(path.join(home, "selection-generation.json"), "utf8"),
    );
    defaultModel = selection.model || null;
    defaultReasoningEffort = selection.effort || null;
    defaultContextTier = selection.contextTier || null;
  } catch {
    try {
      const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
      defaultModel = config.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || null;
      defaultReasoningEffort =
        config.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] || null;
      defaultContextTier = config.match(/^service_tier\s*=\s*"context-long"/m)
        ? "long_context"
        : "default";
    } catch {
      /* no existing profile */
    }
  }
  fs.writeFileSync(
    path.join(payload, "transfer-settings.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAtUtc: new Date().toISOString(),
        defaultModel,
        defaultReasoningEffort,
        defaultContextTier,
        containsCredentials: false,
        migrationPolicy:
          "Install fresh and authenticate separately on the destination machine.",
      },
      null,
      2,
    )}\n`,
  );

  const queue = [payload];
  while (queue.length) {
    const directory = queue.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(file);
      } else if (
        textExtensions.has(path.extname(entry.name).toLowerCase()) &&
        tokenPattern.test(fs.readFileSync(file, "utf8"))
      ) {
        throw new Error(`Potential credential found in transfer bundle: ${file}`);
      }
    }
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.rmSync(output, { force: true });
  execFileSync("tar", ["-czf", output, "-C", payload, "."], {
    stdio: "inherit",
  });
  process.stdout.write(`Created credential-free transfer bundle: ${output}\n`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
