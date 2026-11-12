import { spawn } from "node:child_process";

export function validateGitHubDeviceUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.pathname !== "/login/device"
  ) {
    throw new Error("Only the GitHub device verification page can be opened");
  }
  return url.href;
}

export function openSystemBrowser(
  value,
  spawnProcess = spawn,
  platform = process.platform,
) {
  const href = validateGitHubDeviceUrl(value);
  const [file, args] =
    platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", href]]
      : platform === "darwin"
        ? ["open", [href]]
        : ["xdg-open", [href]];
  const child = spawnProcess(
    file,
    args,
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref?.();
  return href;
}
