import path from "node:path";
import { releaseRoot, releaseMetadata, releaseEnvironment } from "./environment.mjs";
import { boundedJson } from "./paths.mjs";

const metadata = releaseMetadata();
const features = boundedJson(path.join(releaseRoot, "release", "features.json"));
const settingsFile = path.join(releaseRoot, "release-install.json");
let settings;
try { settings = boundedJson(settingsFile); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const env = releaseEnvironment({ home: settings?.profile });
const color = (process.stdout.isTTY || process.argv.includes("--color")) && !process.env.NO_COLOR;
const ansi = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
const width = Math.max(42, Math.min(process.stdout.columns || 88, 96));
const unicode = process.env.CCODEX_ASCII !== "1";
const rule = unicode ? "─" : "-";
const print = text => process.stdout.write(`${text}\n`);
const label = text => ansi("38;5;80", text);
const muted = text => ansi("38;5;245", text);
const icon = (fancy, fallback) => unicode ? fancy : fallback;
print("");
print(label(`  ${icon("╭", "+")}${rule.repeat(width - 6)}${icon("╮", "+")}`));
print(`    ${ansi("1;38;5;221", icon("✦  ", "*  ") + features.title)}`);
print(`    ${features.subtitle}`);
print(label(`  ${icon("╰", "+")}${rule.repeat(width - 6)}${icon("╯", "+")}`));
print("");
print(`  ${ansi("1;38;5;114", icon("✓", "[OK]") + "  RELEASE")}  ccodex ${metadata.packageVersion}`);
print(`  ${label(icon("▣", "[APP]") + "  DESKTOP")}  ${metadata.desktopVendorVersion}  ·  ${metadata.target}`);
print(`  ${label(icon("⚙", "[RUN]") + "  RUNTIME")}  Node ${metadata.nodeVersion}  ·  Copilot ${metadata.copilotVersion}`);
print("");
for (const group of features.groups) {
  print(`  ${label(`${icon(group.icon, "*")}  ${group.name}`)}`);
  for (const item of group.items) print(`     ${icon("›", ">")} ${item}`);
  print("");
}
print(ansi("1;38;5;221", `  ${icon("➜", "->")}  FIRST RUN / 首次使用`));
print("     1. 从开始菜单打开 Ccodex Desktop 或 Ccodex CLI。");
print("     2. 使用自己的 GitHub Copilot 账户登录。");
print("     3. Work IQ: workiq login -> enable --acknowledge-data-sharing。");
print("");
print("  CLI          ccodex");
print("  功能展示     ccodex features");
print("  离线诊断     ccodex release-doctor");
print("  自启动       ccodex autostart on|off");
print("");
print(muted(`  配置目录     ${env.CODEX_HOME}`));
print(muted(`  说明文档     ${path.join(releaseRoot, "docs", "README.zh-CN.md")}`));
print("");
print(ansi("38;5;214", `  ${icon("⚠", "[!]")}  ${features.boundary}`));
print(muted("  功能清单不是账号授权或线上请求的验证结果。请查看 release-diagnostics.json。"));
print("");
