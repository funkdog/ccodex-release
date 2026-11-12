import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { privateDirectory } from "../gateway/spine/storage.mjs";
import { inspectSignedApplication } from "./desktop-host-capabilities.mjs";
import { nativeEnvironment } from "../gateway/native-peer.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const writePrivate = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });

/** Start one persistent Codex repair task per installed CLI and failure class.
 * The task runs separately from the ChatGPT process and never blocks stock launch. */
export async function queueDesktopRepairSession({ root, home, application, category, reason,
  env = process.env, inspect = inspectSignedApplication, run = spawn, git = execFileSync } = {}) {
  const host = inspect(application);
  const cliHash = digest(fs.readFileSync(host.nativeCli));
  const archive = path.join(host.application, "Contents/Resources/app.asar");
  const archiveStat = fs.existsSync(archive) ? fs.statSync(archive, { bigint: true }) : null;
  const archiveStamp = archiveStat ? `${archiveStat.ino}:${archiveStat.size}:${archiveStat.mtimeNs}:${archiveStat.ctimeNs}` : "absent";
  const key = digest(`${host.application}\0${cliHash}\0${archiveStamp}\0${category}`).slice(0, 32);
  const directory = privateDirectory(path.join(home, "repair"));
  const stateFile = path.join(directory, `${key}.json`);
  if (fs.existsSync(stateFile)) return { action: "already-queued", stateFile };
  const logFile = path.join(directory, `${key}.jsonl`);
  const promptFile = path.join(directory, `${key}.prompt.txt`);
  let clean = false;
  try {
    clean = git("git", ["status", "--porcelain", "--untracked-files=normal"],
      { cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }).trim() === "";
  } catch { /* A source checkout we cannot classify is read-only. */ }
  const prompt = [
    "修复 MyCodex 与更新后 ChatGPT 的兼容问题。此会话由 MyCodex 在启动兜底后自动创建。",
    `源码目录：${root}`,
    `故障类别：${category}`,
    `启动检查摘要：${String(reason).slice(0, 1000)}`,
    "官方 ChatGPT 已按原版方式启动。不要关闭、替换或修改正在运行的客户端与现有会话。",
    "读取项目 AGENTS.md，检查安装版本、日志、源码与现有门禁。找出根因并验证修复。",
    clean ? "源码当前干净；请在隔离工作区完成修复，按项目发布规则交付并报告验证结果。"
      : "源码存在未提交改动；先只读诊断并报告可执行修复方案，避免覆盖或并发修改现有工作。",
    "不要把预检通过、源码修改或未验证的安装包称为已完成发布。",
  ].join("\n");
  try { writePrivate(stateFile, { schemaVersion: 1, category, cliSha256: cliHash,
    action: "queued", mode: clean ? "isolated-worktree" : "read-only-diagnosis", createdAt: new Date().toISOString(), logFile }); }
  catch (error) { if (error.code === "EEXIST") return { action: "already-queued", stateFile }; throw error; }
  let input, output, child;
  try {
    fs.writeFileSync(promptFile, prompt + "\n", { flag: "wx", mode: 0o600 });
    input = fs.openSync(promptFile, "r"); output = fs.openSync(logFile, "wx", 0o600);
    const args = ["exec", "--json", "-C", root, "-c", 'model_provider="openai"',
      "--sandbox", clean ? "workspace-write" : "read-only",
      ...(clean ? ["--worktree", "--approve-for-me"] : []), "-"];
    child = run(host.nativeCli, args, { cwd: root, env: nativeEnvironment(env),
      detached: true, stdio: [input, output, output] });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const pending = `${stateFile}.${process.pid}.pending`;
    writePrivate(pending, { schemaVersion: 1, category, cliSha256: cliHash,
      action: "queued", mode: clean ? "isolated-worktree" : "read-only-diagnosis",
      pid: child.pid, createdAt: new Date().toISOString(), logFile });
    fs.renameSync(pending, stateFile);
    child.unref();
    return { action: "queued", pid: child.pid, stateFile, mode: clean ? "isolated-worktree" : "read-only-diagnosis" };
  } catch (error) {
    if (child?.pid) child.kill?.("SIGTERM");
    fs.rmSync(stateFile, { force: true });
    fs.rmSync(promptFile, { force: true });
    fs.rmSync(logFile, { force: true });
    throw error;
  } finally {
    if (input !== undefined) fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
  }
}

/** Status-only lookup; never parses prompts or agent output. */
export function latestDesktopRepairSession(home, category) {
  const directory = path.join(home, "repair");
  if (!fs.existsSync(directory)) return null;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return null;
  const files = fs.readdirSync(directory).filter(name => /^[a-f0-9]{32}\.json$/.test(name));
  const candidates = files.map(name => {
    const file = path.join(directory, name), value = fs.lstatSync(file);
    return value.isFile() && !value.isSymbolicLink() && value.uid === process.getuid() &&
      !(value.mode & 0o077) && value.size <= 4096 ? { file, mtimeMs: value.mtimeMs } : null;
  }).filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = candidates.find(candidate => {
    if (!category) return true;
    try { return JSON.parse(fs.readFileSync(candidate.file, "utf8")).category === category; }
    catch { return false; }
  });
  if (!latest) return null;
  const value = JSON.parse(fs.readFileSync(latest.file, "utf8"));
  if (value.schemaVersion !== 1 || value.action !== "queued" ||
      !["isolated-worktree", "read-only-diagnosis"].includes(value.mode)) return null;
  const log = latest.file.replace(/\.json$/, ".jsonl");
  if (fs.existsSync(log)) {
    const logStat = fs.lstatSync(log);
    if (logStat.isFile() && !logStat.isSymbolicLink() && logStat.uid === process.getuid() && !(logStat.mode & 0o077)) {
      const buffer = Buffer.alloc(Math.min(logStat.size, 65536));
      const fd = fs.openSync(log, "r");
      try { fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
      for (const line of buffer.toString("utf8").split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started" && typeof event.thread_id === "string" &&
              /^[a-zA-Z0-9_-]{8,128}$/.test(event.thread_id))
            return { action: "created", mode: value.mode, threadId: event.thread_id };
        } catch { /* Ignore incomplete output lines. */ }
      }
    }
  }
  if (Number.isSafeInteger(value.pid) && value.pid > 0) {
    try { process.kill(value.pid, 0); return { action: "launching", mode: value.mode }; }
    catch (error) { if (error.code === "EPERM") return { action: "launching", mode: value.mode }; }
    return { action: "failed", mode: value.mode };
  }
  return { action: "launching", mode: value.mode };
}
