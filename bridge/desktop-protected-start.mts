import { spawn } from "node:child_process";
import { currentHostEnvironment, runningHost } from "./desktop-current-host.mjs";
import { assertPrivateDesktopHome } from "./desktop-runtime.mjs";
import { acquireDesktopStartLock } from "./desktop-instance.mjs";
import { privateDirectory } from "../gateway/spine/storage.mjs";
import { inspectSignedApplication } from "./desktop-host-capabilities.mjs";

interface ProtectedHost { application: string; executable: string; nativeCli: string }
/** Signature trust is separate from private page compatibility. This accepts
 * only the installed OpenAI app; no fallback copies, profiles or UI injection. */
export const inspectProtectedApplication = inspectSignedApplication;
export async function launchProtectedCurrentHost({ root, application, home, inherited = process.env, reason = "Protocol backend unavailable",
  inspectApplication = inspectProtectedApplication, processes = runningHost,
  start = async (executable, env) => {
    const child = spawn(executable, [], { env, detached: true, stdio: "ignore", cwd: inherited.HOME ?? process.cwd() });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref(); return child.pid!;
  }, lock = acquireDesktopStartLock }: {
  root: string; application: string; home: string; inherited?: NodeJS.ProcessEnv; reason?: string;
  inspectApplication?: (application: string) => ProtectedHost; processes?: (executable: string) => { pid: number }[];
  start?: (executable: string, env: NodeJS.ProcessEnv) => Promise<number>; lock?: (home: string) => () => void;
}) {
  const host = inspectApplication(application);
  currentHostEnvironment(inherited, {}); // Reject inherited profile overrides before any writes.
  const existing = processes(host.executable);
  if (existing.length) return { application: host.application, action: "activate-existing", pid: existing[0].pid, launchPerformed: false, enhancementAvailable: false };
  const privateHome = assertPrivateDesktopHome(home, { inherited });
  privateDirectory(privateHome);
  const release = lock(privateHome);
  try {
    // A broken adapter must not sit between the official app and its own CLI.
    // Existing third-party threads remain stored; the stock app may report
    // provider mismatch until MyCodex is repaired, but cannot route them here.
    const env = currentHostEnvironment(inherited, {});
    const intervening = processes(host.executable);
    if (intervening.length) return { application: host.application, action: "activate-existing", pid: intervening[0].pid, launchPerformed: false, enhancementAvailable: false };
    const pid = await start(host.executable, env);
    return { application: host.application, action: "started", pid, launchPerformed: true, enhancementAvailable: false,
      message: `官方 ChatGPT 已按原版方式启动。MyCodex 增强暂不可用；第三方会话保留，修复后才能续聊。原因：${reason.slice(0, 500)}` };
  } finally { release(); }
}
