/** Development acceptance only. Never switches the user's running backend.
 * UI inspection/clicks belong to the human or allowed App tools, not this CLI. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertTypeScriptBuild } from "../tools/typescript-state.mjs";
import { inspectCurrentHost } from "./desktop-current-host.mjs";
import { inspectSignedApplication } from "./desktop-host-capabilities.mjs";
import { assertPrivateDesktopHome } from "./desktop-runtime.mjs";
import { readProcessIdentity, sameProcessLifetime, desktopEndpointOwner } from "./desktop-process.mjs";
import { publicProcessIdentity } from "./desktop-instance.mjs";
import { startGateway } from "../gateway/server.mjs";
import type { ConnectionConfig, EngineAdapter } from "../gateway/contracts.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { connectGateway, writeMessage } from "../gateway/ipc.mjs";
import { privateDirectory } from "../gateway/spine/storage.mjs";
import { readJson, writeJson } from "../gateway/spine/io.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const marker = ".mycodex-acceptance.json";
export const acceptancePrompt = "MYCODEX_ACCEPTANCE_PING";
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
type Identity = { pid: number; platform: string; lifetime: string; executable: string };
interface Owner { schemaVersion: 1; purpose: "mycodex-offline-acceptance"; root: string; id: string; sourceRoot: string }
interface Plan extends Owner { application: string; applicationVersion: string; archiveSha256: string; cliSha256: string }

export function assertAcceptanceRoot(directory: string): Owner {
  if (!path.isAbsolute(directory)) throw new Error("Acceptance root must be absolute.");
  const root = fs.realpathSync(directory);
  assertPrivateDesktopHome(root);
  if (root !== path.resolve(directory) || !/^mc-accept-[A-Za-z0-9]+$/.test(path.basename(root))) throw new Error("Not an owned acceptance root.");
  privateDirectory(root, false);
  const owner = readJson(path.join(root, marker)) as Owner;
  if (owner.schemaVersion !== 1 || owner.purpose !== "mycodex-offline-acceptance" || owner.root !== root || !/^[a-f0-9-]{36}$/.test(owner.id) || owner.sourceRoot !== sourceRoot)
    throw new Error("Invalid acceptance ownership marker.");
  return owner;
}

/** HOME as well as both product profiles are private. No account/CLI/proxy
 * credentials, shell startup options or active gateway environment survive. */
export function acceptanceEnvironment(root: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  assertAcceptanceRoot(root);
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/sh", CODEX_SHELL: "/bin/sh",
    HOME: path.join(root, "user-home"), TMPDIR: path.join(root, "tmp"), XDG_CACHE_HOME: path.join(root, "cache"),
    CODEX_HOME: path.join(root, "profile"), CODEX_ELECTRON_USER_DATA_PATH: path.join(root, "user-data"),
    CODEX_CLI_PATH: path.join(root, "codex"), CCODEX_APP_SERVER_PROBE_ROOT: root,
    CODEX_APP_SERVER_FORCE_CLI: "1", CODEX_ELECTRON_DISABLE_QUIT_CONFIRMATION: "1" };
  for (const key of ["LANG", "LC_CTYPE", "USER", "LOGNAME"]) if (inherited[key]) env[key] = inherited[key];
  return env;
}

/** Backend probes only. Electron retains its own renderer sandbox. */
export function acceptanceSandbox(root: string) {
  assertAcceptanceRoot(root);
  return `(version 1) (allow default) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null")) (deny network-outbound) (allow network-outbound (remote ip "localhost:*") (remote unix-socket (subpath ${JSON.stringify(root)})))`;
}

function fixturePng() {
  const crc32 = (bytes: Buffer) => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (name: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(name), data]), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([size, body, crc]); };
  const width = 480, height = 240, header = Buffer.alloc(13), pixels = Buffer.alloc((width * 3 + 1) * height);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = y * (width * 3 + 1) + 1 + x * 3; pixels[i] = 30 + Math.floor(x * 150 / width); pixels[i + 1] = 80 + Math.floor(y * 120 / height); pixels[i + 2] = (Math.floor(x / 40) + Math.floor(y / 40)) % 2 ? 200 : 120; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

export async function prepareAcceptance(application: string, radarSchema: string, outputParent = process.platform === "darwin" ? "/private/tmp" : os.tmpdir()) {
  assertTypeScriptBuild(sourceRoot);
  inspectSignedApplication(application);
  const host = inspectCurrentHost(application);
  if (!path.isAbsolute(radarSchema) || !fs.lstatSync(radarSchema).isFile() || fs.lstatSync(radarSchema).isSymbolicLink()) throw new Error("Explicit regular radar schema is required.");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(outputParent), "mc-accept-")); fs.chmodSync(root, 0o700);
  if (Buffer.byteLength(root + "/tmp/.org.chromium.Chromium.XXXXXX/SingletonSocket") >= 104) { fs.rmdirSync(root); throw new Error("Use a short temporary root for macOS Unix sockets."); }
  const owner: Owner = { schemaVersion: 1, purpose: "mycodex-offline-acceptance", root, id: randomUUID(), sourceRoot };
  writeJson(path.join(root, marker), owner);
  for (const name of ["profile", "user-data", "workspace", "user-home", "tmp", "cache"]) privateDirectory(path.join(root, name));
  const clone = path.join(root, "MyCodex Acceptance.app");
  // APFS clone of the signed app, no ASAR/bundle changes or registration.
  execFileSync("/bin/cp", ["-cR", host.application, clone], { timeout: 60000 });
  inspectSignedApplication(clone);
  const copied = inspectCurrentHost(clone);
  if (copied.archiveSha256 !== host.archiveSha256 || copied.cliSha256 !== host.cliSha256) throw new Error("Application changed while creating the acceptance copy.");
  seedAcceptanceFixtures(root, radarSchema);
  const plan: Plan = { ...owner, application: clone, applicationVersion: copied.applicationVersion, archiveSha256: copied.archiveSha256, cliSha256: copied.cliSha256 };
  writeJson(path.join(root, "plan.json"), plan);
  return { root, applicationVersion: plan.applicationVersion, application: clone, prepared: true, launched: false };
}

export function seedAcceptanceFixtures(root: string, radarSchema: string) {
  assertAcceptanceRoot(root);
  fs.copyFileSync(radarSchema, path.join(root, "report.schema.json")); fs.chmodSync(path.join(root, "report.schema.json"), 0o600);
  fs.copyFileSync(path.join(sourceRoot, "tests/fixtures/desktop-app-server-probe.mjs"), path.join(root, "native-fixture.mjs"));
  fs.writeFileSync(path.join(root, ".ccodex-probe"), "isolated synthetic transport\n", { mode: 0o600, flag: "wx" });
  fs.writeFileSync(path.join(root, "native-fixture"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, "native-fixture.mjs"))} "$@"\n`, { mode: 0o700, flag: "wx" });
  fs.writeFileSync(path.join(root, "codex"), `#!/bin/sh\nCCODEX_GATEWAY_CONNECTION=${quote(path.join(root, "connection.json"))} CCODEX_NATIVE_CLI=${quote(path.join(root, "native-fixture"))} exec ${quote(process.execPath)} ${quote(path.join(sourceRoot, "gateway/routed-stdio.mjs"))} "$@"\n`, { mode: 0o700, flag: "wx" });
  fs.writeFileSync(path.join(root, "profile/config.toml"), 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n', { mode: 0o600, flag: "wx" });
  // This is an onboarding preference in our fresh fixture, never copied auth.
  writeJson(path.join(root, "profile/.codex-global-state.json"), { "electron-persisted-atom-state": {
    "chatgpt-migration-announcement-completed-v1": true,
    "electron:onboarding-welcome-v2-role-state": { completedConversationalOnboarding: true, conversationalOnboardingSkipped: true, roles: [], personalizedSuggestionsEnabled: false, workMode: "coding" },
    "electron:onboarding-projectless-completed": true, "electron:onboarding-hide-first-new-thread-promos": true,
  } });
  fs.writeFileSync(path.join(root, "workspace/acceptance.png"), fixturePng(), { mode: 0o600, flag: "wx" });
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  writeJson(path.join(root, "report.json"), { schema_version: 1, report_date: date, timezone: "Asia/Shanghai", window_start: date + "T00:00:00+08:00", window_end: date + "T09:00:00+08:00", title: "MyCodex 隔离验收 · 合成雷达", intro: "仅验收交互，不代表真实研究结论。", status: "complete", coverage: "synthetic fixture only", items: [
    { title: "合成条目：会话图片与恢复", topics: ["agents"], summary: "用于检查筛选、反馈撤销、草稿预填及候选知识卡入库。", sources: [{ title: "Fixture reference", url: "https://example.test/acceptance" }], priority: { score: 5, reason: "Synthetic acceptance priority" } },
    { title: "合成条目：网关输出边界", topics: ["infra"], summary: "用于检查第二个筛选项。", sources: [{ title: "Fixture reference", url: "https://example.test/infra" }], priority: { score: 3, reason: "Synthetic acceptance priority" } },
  ] });
}

export async function createAcceptanceGateway(root: string) {
  const owner = assertAcceptanceRoot(root);
  const connection: ConnectionConfig = { home: path.join(root, "profile"), endpoint: path.join(root, "gateway.sock"), token: randomUUID(), generation: "acceptance:" + owner.id,
    frontend: "routed-stdio.mjs", engines: [], spine: { mcp: false, eventTap: true, radar: { schemaFile: path.join(root, "report.schema.json"), reportFile: path.join(root, "report.json") }, daily: { repositories: [], timezone: "Asia/Shanghai" }, ui: { rightOffset: 64 } } };
  const engine: EngineAdapter = { displayName: "MyCodex 验收（合成，无模型调用）", approvalModes: ["deny"],
    models: async () => [{ id: "fixture", name: "Fixture", supportedReasoningEfforts: ["none"], defaultReasoningEffort: "none" }],
    run: async ({ prompt, cwd, signal, onSession, onText, onTool }) => {
      if (fs.realpathSync(cwd) !== fs.realpathSync(path.join(root, "workspace")) || !prompt.split("\n").some(line => line.trim() === acceptancePrompt)) throw new Error(`此实例只接受 ${acceptancePrompt}，不会调用真实模型或执行工具。`);
      signal.throwIfAborted(); onSession("acceptance:" + randomUUID());
      onText("MYCODEX_ACCEPTANCE_OK · 以下为本机生成的合成图片。没有模型调用或外部工具执行。");
      const toolId = randomUUID();
      onTool?.({ phase: "start", id: toolId, name: "fixture_image", input: { fixture: true } });
      onTool?.({ phase: "end", id: toolId, success: true, output: { fixture: true }, images: [{ kind: "file", path: path.join(root, "workspace/acceptance.png") }] });
    } };
  const gateway = await startGateway({ ...connection, engines: new Map([["acceptance", engine]]), defaultEngine: "acceptance" });
  try {
    writeJson(path.join(root, "connection.json"), connection);
    if (!gateway.protocol.store.all().length) {
      let socket!: net.Socket; const peer = new RpcPeer(message => writeMessage(socket, message));
      socket = await connectGateway(connection, message => peer.receive(message));
      try {
        await peer.request("initialize", { clientInfo: { name: "mycodex_acceptance_seed", version: "1" } });
        const { thread } = await peer.request<{ thread: { id: string } }>("thread/start", { model: "acceptance/fixture", cwd: path.join(root, "workspace"), cliApprovalMode: "deny", approvalPolicy: "never" });
        await peer.request("thread/name/set", { threadId: thread.id, name: "MYCODEX-ACCEPTANCE-IMAGE" });
        await peer.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: acceptancePrompt }] });
        await gateway.protocol.active.get(thread.id)?.done;
      } finally { socket.destroy(); peer.close(); }
    }
    return { ...gateway, connection, threadIds: gateway.protocol.store.all().map(thread => thread.id) };
  } catch (error) { await gateway.close(); throw error; }
}

async function port() {
  const server = net.createServer(); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
function spawnLogged(executable: string, args: string[], root: string, name: string) {
  const fd = fs.openSync(path.join(root, name), fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { return spawn(executable, args, { env: acceptanceEnvironment(root), cwd: path.join(root, "workspace"), detached: true, stdio: ["ignore", fd, fd] }); }
  finally { fs.closeSync(fd); }
}
async function stopChild(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const identity = readProcessIdentity(child.pid);
  if (!identity) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const send = (signal: NodeJS.Signals) => { if (sameProcessLifetime(identity, readProcessIdentity(child.pid))) { try { process.kill(-child.pid!, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };
  send("SIGTERM"); await Promise.race([exited, pause(2000)]); send("SIGKILL"); await Promise.race([exited, pause(1000)]);
}

function snapshotProcesses(root: string): Identity[] {
  return execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 10000 }).split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || !match[2].startsWith(root + path.sep)) return [];
    const identity = readProcessIdentity(Number(match[1])) as Identity | null;
    return identity?.executable.startsWith(root + path.sep) ? [identity] : [];
  });
}
async function stopSnapshotHelpers(root: string) {
  const owned = snapshotProcesses(root);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const identity of owned) if (sameProcessLifetime(identity, readProcessIdentity(identity.pid))) {
      try { process.kill(identity.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    if (!snapshotProcesses(root).length) return;
    await pause(250);
  }
  if (snapshotProcesses(root).length) throw new Error("Owned acceptance helpers remain alive; temporary files were retained.");
}

export function cleanupAcceptance(root: string) {
  assertAcceptanceRoot(root);
  const receiptFile = path.join(root, "receipt.json");
  if (fs.existsSync(receiptFile)) {
    const receipt = readJson(receiptFile) as { identity: Identity; helperIdentity?: Identity };
    if (receipt.identity?.executable !== path.join(root, "MyCodex Acceptance.app/Contents/MacOS/ChatGPT")) throw new Error("Receipt does not belong to this acceptance app.");
    for (const identity of [receipt.identity, receipt.helperIdentity]) if (identity && sameProcessLifetime(identity, readProcessIdentity(identity.pid))) throw new Error("Close the acceptance window before cleanup.");
  }
  if (snapshotProcesses(root).length) throw new Error("Acceptance processes still own their files.");
  const remove = (file: string) => {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (stat.uid !== process.getuid!()) throw new Error("Acceptance cleanup encountered another owner.");
      if ((stat.mode & 0o700) !== 0o700) fs.chmodSync(file, stat.mode | 0o700);
      for (const child of fs.readdirSync(file)) remove(path.join(file, child));
      fs.rmdirSync(file);
    } else fs.unlinkSync(file);
  };
  remove(root);
}

export async function waitAcceptanceEndpoint(identity: Identity, debugPort: number, timeoutMs = 20000) {
  const endpointOwner = desktopEndpointOwner as unknown as (port: number, options: { pid: number }) => number | null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && sameProcessLifetime(identity, readProcessIdentity(identity.pid))) {
    try { if (endpointOwner(debugPort, { pid: identity.pid }) === identity.pid) return; }
    catch (error) { if (!/does not own the private loopback listener/.test((error as Error).message)) throw error; }
    await pause(250);
  }
  throw new Error("Acceptance endpoint is not owned by its isolated app.");
}

export async function waitAcceptanceIdentity(child: ChildProcess, executable: string, timeoutMs = 10000): Promise<Identity> {
  const deadline = Date.now() + timeoutMs;
  let observed: string | undefined;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const identity = publicProcessIdentity(readProcessIdentity(child.pid)) as Identity | null;
    observed = identity?.executable;
    if (identity?.executable === executable) return identity;
    await pause(100);
  }
  throw new Error(`Acceptance app lifetime could not be verified (exit=${child.exitCode}, signal=${child.signalCode}, observed=${observed ?? "unavailable"}).`);
}

export async function runAcceptance(root: string, lifetimeMs = 1800000) {
  assertTypeScriptBuild(sourceRoot); assertAcceptanceRoot(root);
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 3600000) throw new Error("Acceptance lifetime must be 1 second–1 hour.");
  const plan = readJson(path.join(root, "plan.json")) as Plan;
  if (plan.root !== root || plan.application !== path.join(root, "MyCodex Acceptance.app")) throw new Error("Acceptance application escaped its private root.");
  inspectSignedApplication(plan.application);
  const host = inspectCurrentHost(plan.application);
  if (host.running.length || host.archiveSha256 !== plan.archiveSha256 || host.cliSha256 !== plan.cliSha256) throw new Error("Acceptance copy is already running or changed.");
  const gateway = await createAcceptanceGateway(root); let app: ChildProcess | undefined, helper: ChildProcess | undefined;
  let finish!: () => void; const ended = new Promise<void>(resolve => { finish = resolve; });
  const timer = setTimeout(finish, lifetimeMs), stop = () => finish(); process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    const debugPort = await port(); app = spawnLogged(host.executable, [`--user-data-dir=${path.join(root, "user-data")}`, "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${debugPort}`], root, "desktop.log");
    app.once("exit", finish); app.once("error", finish);
    await new Promise<void>((resolve, reject) => { app!.once("spawn", resolve); app!.once("error", reject); });
    const identity = await waitAcceptanceIdentity(app, host.executable);
    const receiptFile = path.join(root, "receipt.json"), sourceGeneration = createHash("sha256").update(fs.readFileSync(path.join(sourceRoot, "tools/typescript-build-manifest.json"))).digest("hex");
    const receipt = { schemaVersion: 1, application: host.application, archiveSha256: host.archiveSha256, cliSha256: host.cliSha256, generation: gateway.connection.generation,
      identity, port: debugPort, connectionFile: path.join(root, "connection.json"), sourceGeneration, state: "started", threadIds: gateway.threadIds };
    writeJson(receiptFile, receipt);
    await waitAcceptanceEndpoint(identity, debugPort);
    // Product mounting only. No test DOM reads, clicks or UI screenshots.
    helper = spawnLogged(process.execPath, [path.join(sourceRoot, "bridge/desktop-gateway-ui.mjs"), receiptFile], root, "helper.log");
    await new Promise<void>((resolve, reject) => { helper!.once("spawn", resolve); helper!.once("error", reject); });
    writeJson(receiptFile, { ...receipt, helperIdentity: publicProcessIdentity(readProcessIdentity(helper.pid)) });
    process.stdout.write(JSON.stringify({ root, pid: identity.pid, helperPid: helper.pid, applicationVersion: host.applicationVersion, threadIds: gateway.threadIds, uiAccepted: false, lifetimeMs }) + "\n");
    await ended;
  } finally {
    clearTimeout(timer); process.off("SIGTERM", stop); process.off("SIGINT", stop);
    await stopChild(helper); await stopChild(app); await stopSnapshotHelpers(root); await gateway.close();
    writeJson(path.join(root, "stopped.json"), { at: new Date().toISOString(), uiAccepted: false });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "prepare" && args.length === 2) console.log(JSON.stringify(await prepareAcceptance(args[0], args[1])));
    else if (command === "run" && (args.length === 1 || args.length === 2)) await runAcceptance(args[0], args[1] ? Number(args[1]) : undefined);
    else if (command === "cleanup" && args.length === 1) { cleanupAcceptance(args[0]); console.log("Owned acceptance files removed."); }
    else throw new Error("Usage: desktop-acceptance.mjs prepare <official.app> <radar.schema.json> | run <owned-root> [lifetime-ms] | cleanup <owned-root>");
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
