import assert from "node:assert/strict";
import { openSystemBrowser, validateGitHubDeviceUrl } from "../bridge/desktop-actions.mjs";

assert.equal(
  validateGitHubDeviceUrl("https://github.com/login/device"),
  "https://github.com/login/device",
);
assert.equal(
  validateGitHubDeviceUrl("https://github.com/login/device?user_code=ABCD-EFGH"),
  "https://github.com/login/device?user_code=ABCD-EFGH",
);
for (const rejected of [
  "http://github.com/login/device",
  "https://example.com/login/device",
  "https://github.com/settings/profile",
]) {
  assert.throws(() => validateGitHubDeviceUrl(rejected));
}

let invocation = null;
let unrefCalled = false;
const href = openSystemBrowser(
  "https://github.com/login/device?user_code=TEST-CODE",
  (file, args, options) => {
    invocation = { file, args, options };
    return {
      unref() {
        unrefCalled = true;
      },
    };
  },
);
assert.equal(href, "https://github.com/login/device?user_code=TEST-CODE");
assert.deepEqual(invocation, {
  file: "rundll32.exe",
  args: [
    "url.dll,FileProtocolHandler",
    "https://github.com/login/device?user_code=TEST-CODE",
  ],
  options: {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  },
});
assert.equal(unrefCalled, true);

for (const [platform, file, args] of [
  ["darwin", "open", ["https://github.com/login/device"]],
  ["linux", "xdg-open", ["https://github.com/login/device"]],
]) {
  let call = null;
  openSystemBrowser(
    "https://github.com/login/device",
    (spawnFile, spawnArgs, options) => {
      call = { file: spawnFile, args: spawnArgs, options };
      return { unref() {} };
    },
    platform,
  );
  assert.equal(call.file, file);
  assert.deepEqual(call.args, args);
}

process.stdout.write("Desktop system browser action test passed.\n");
