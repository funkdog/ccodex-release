import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/** Application trust and protocol support are independent of renderer exports. */
export function inspectSignedApplication(application: string) {
  if (process.platform !== "darwin" || !path.isAbsolute(application) || !application.endsWith(".app"))
    throw new Error("Backend startup requires an explicit macOS application.");
  const app = fs.realpathSync(application);
  const executable = path.join(app, "Contents/MacOS/ChatGPT"), nativeCli = path.join(app, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
  for (const file of [executable, nativeCli]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Host executables must be regular original files.");
  }
  const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8", timeout: 10000 });
  const identity = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", app], { encoding: "utf8", timeout: 10000 });
  if (verify.status !== 0 || identity.status !== 0 || !/^Identifier=com\.openai\.codex$/m.test(identity.stderr) || !/^TeamIdentifier=2DC432GLL2$/m.test(identity.stderr))
    throw new Error("Backend startup requires the verified OpenAI signature.");
  return { application: app, executable, nativeCli };
}

const consumed: Record<string, string[]> = {
  ThreadStartParams: ["model", "modelProvider", "cwd", "config", "approvalPolicy", "permissions", "runtimeWorkspaceRoots"],
  ThreadResumeParams: ["threadId", "model", "modelProvider", "config"],
  TurnStartParams: ["threadId", "input", "model", "effort", "permissions", "approvalPolicy", "collaborationMode"],
  ThreadForkParams: ["threadId", "lastTurnId", "beforeTurnId", "modelProvider", "config"],
  ThreadDeleteParams: ["threadId"], ThreadMetadataUpdateParams: ["threadId", "projectId"],
  ThreadSearchParams: ["searchTerm", "cursor", "limit"], ThreadSectionMoveParams: ["threadId", "sectionId", "beforeThreadId"],
};
type Schema = { properties?: Record<string, unknown>; required?: string[] };
export function checkNativeSchemas(read: (name: string) => Schema) {
  for (const [name, fields] of Object.entries(consumed)) {
    const schema = read(name);
    for (const field of fields) if (!Object.hasOwn(schema.properties ?? {}, field))
      throw new Error(`Native protocol incompatible: ${name}.${field} missing.`);
    for (const field of schema.required ?? []) if (!fields.includes(field))
      throw new Error(`Native protocol incompatible: ${name} now requires ${field}.`);
  }
}
const checked = new Set<string>();
/** Validate the consumed schema and provider behavior in an isolated temporary profile.
 * The local fixture checks routing without accessing user chats or model accounts. */
export function assertNativeProtocol(executable: string) {
  if (!path.isAbsolute(executable) || !fs.statSync(executable).isFile()) throw new Error("Original native CLI is required for protocol inspection.");
  const sha256 = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  if (checked.has(sha256)) return { cliSha256: sha256, protocolAvailable: true, providerBehaviorVerified: true };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-native-contract-")); fs.chmodSync(root, 0o700);
  try {
    const output = path.join(root, "schema");
    const env = { HOME: root, CODEX_HOME: root, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
    const result = spawnSync(executable, ["app-server", "generate-json-schema", "--experimental", "--out", output],
      { env, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error("Native protocol export failed; the running client was preserved.");
    const files = fs.readdirSync(output, { recursive: true }).filter((file): file is string => typeof file === "string");
    checkNativeSchemas(name => {
      const file = files.find(file => file === `${name}.json` || file.endsWith(`/${name}.json`));
      if (!file) throw new Error(`Native protocol incompatible: ${name} missing.`);
      return JSON.parse(fs.readFileSync(path.join(output, file), "utf8")) as Schema;
    });
    const behavior = spawnSync(process.execPath, [path.join(import.meta.dirname, "native-provider-compat-probe.mjs"), executable],
      { env, encoding: "utf8", timeout: 20000, maxBuffer: 16384 });
    let verified = false;
    try { verified = JSON.parse(behavior.stdout || "null")?.providerBehaviorVerified === true; } catch {}
    if (behavior.status !== 0 || behavior.error || !verified)
      throw new Error(`Native provider behavior incompatible: ${behavior.stderr?.trim().slice(0, 500) || behavior.error?.message || "probe returned no verified result"}`);
    checked.add(sha256);
    return { cliSha256: sha256, protocolAvailable: true, providerBehaviorVerified: true };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
