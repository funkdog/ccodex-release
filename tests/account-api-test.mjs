import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { syntheticCopilotMetadata } from "./fixtures/copilot-sdk-metadata.mjs";

const installRoot = process.env.TEST_INSTALL_ROOT;
const profileHome = process.env.TEST_PROFILE_HOME;
if (!installRoot || !profileHome) {
  throw new Error("TEST_INSTALL_ROOT and TEST_PROFILE_HOME are required.");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
const freePort = async () => {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
};

let deviceSequence = 0;
const models = Array.from({ length: 18 }, (_, index) => ({
  id: `gpt-5-desktop-${String(index + 1).padStart(2, "0")}`,
  name: `GPT-5 Desktop ${index + 1}`,
  vendor: "OpenAI",
  model_picker_enabled: true,
  is_chat_default: index === 0,
  supported_endpoints: ["/responses"],
  capabilities: {
    type: "chat",
    family: "gpt",
    supports: { reasoning_effort: ["low", "high"] },
    limits: {
      max_prompt_tokens: 272000,
      max_context_window_tokens: 400000,
      max_output_tokens: 128000,
    },
  },
}));

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const json = (status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  };
  if (url.pathname === "/device/code") {
    deviceSequence += 1;
    json(200, {
      device_code: `device-${deviceSequence}`,
      user_code: `TEST-${deviceSequence}`,
      verification_uri: "https://github.example/device",
      expires_in: 60,
      interval: 1,
    });
    return;
  }
  if (url.pathname === "/device/token") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const deviceCode = JSON.parse(body).device_code;
    if (deviceCode === "device-1") {
      json(200, { access_token: "fake-cli-token" });
    } else if (deviceCode === "device-2") {
      json(200, { access_token: "fake-desktop-token" });
    } else {
      json(200, { error: "authorization_pending" });
    }
    return;
  }
  if (url.pathname === "/user") {
    const authorization = req.headers.authorization || "";
    json(200, {
      login: authorization.includes("fake-cli-token")
        ? "cli-test-user"
        : "desktop-test-user",
    });
    return;
  }
  if (url.pathname === "/models") {
    json(200, { data: models });
    return;
  }
  json(404, { error: "not_found" });
});

const mockPort = await listen(mock);
const bridgePort = await freePort();
const sdk = syntheticCopilotMetadata(installRoot, profileHome, models.map(model => ({
  id: model.id, billing: { tokenPrices: { maxPromptTokens: model.capabilities.limits.max_prompt_tokens } },
})));
const bridge = spawn(process.execPath, [...sdk.nodeArguments, path.join(installRoot, "bridge", "server.mjs")], {
  cwd: installRoot,
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    APPDATA: path.join(profileHome, "empty-appdata"),
    CODEX_COPILOT_HOME: profileHome,
    CODEX_COPILOT_CLI_SDK: sdk.sdkPath,
    CODEX_COPILOT_BRIDGE_PORT: String(bridgePort),
    CODEX_COPILOT_API_BASE: `http://127.0.0.1:${mockPort}`,
    CODEX_COPILOT_GITHUB_DEVICE_CODE_URL: `http://127.0.0.1:${mockPort}/device/code`,
    CODEX_COPILOT_GITHUB_DEVICE_TOKEN_URL: `http://127.0.0.1:${mockPort}/device/token`,
    CODEX_COPILOT_GITHUB_API_BASE: `http://127.0.0.1:${mockPort}`,
  },
});

const endpoint = `http://127.0.0.1:${bridgePort}`;
const request = async (route, options = {}) => {
  const response = await fetch(endpoint + route, {
    ...options,
    headers: { origin: "app://-", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
};
const runCliSwitch = () =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(installRoot, "bridge", "cli.mjs"), "account", "switch"],
      {
        cwd: installRoot,
        windowsHide: true,
        env: {
          ...process.env,
          CODEX_COPILOT_HOME: profileHome,
          CODEX_COPILOT_BRIDGE_PORT: String(bridgePort),
          CODEX_COPILOT_NO_BROWSER: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("CLI account switch timed out."));
    }, 60_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`CLI switch exited ${code}: ${stderr || stdout}`));
    });
  });

try {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/health`);
      if (response.ok) break;
    } catch {
      /* bridge is still starting */
    }
    await sleep(100);
  }

  const rejected = await fetch(`${endpoint}/account`, {
    headers: { origin: "https://example.com" },
  });
  if (rejected.status !== 403) throw new Error("Untrusted account origin was not rejected.");

  const initialPid = (await fetch(`${endpoint}/health`).then((res) => res.json())).pid;
  const cliSwitch = await runCliSwitch();
  if (
    !cliSwitch.stdout.includes("TEST-1") ||
    !cliSwitch.stdout.includes("Signed in as cli-test-user")
  ) {
    throw new Error(`CLI did not use the shared account flow: ${cliSwitch.stdout}`);
  }
  const cliAccount = (await request("/account")).body;
  if (cliAccount.login !== "cli-test-user" || cliAccount.models !== 18) {
    throw new Error(`Desktop did not observe the CLI account: ${JSON.stringify(cliAccount)}`);
  }
  if (!cliAccount.accountGeneration) {
    throw new Error("CLI account switch did not publish an account generation.");
  }
  const firstAccountGeneration = cliAccount.accountGeneration;

  const started = await request("/account/switch", { method: "POST" });
  if (started.response.status !== 202 || started.body.userCode !== "TEST-2") {
    throw new Error(`Unexpected switch start response: ${JSON.stringify(started.body)}`);
  }
  if (JSON.stringify(started.body).includes("fake-desktop-token")) {
    throw new Error("Account API exposed an OAuth token.");
  }

  let completed = started.body;
  // A packaged SDK can use its existing startup/listing deadlines while
  // refreshing metadata. Wait for the real terminal state, not a five-second race.
  const switchDeadline = Date.now() + 75_000;
  while (["starting", "pending"].includes(completed.status) && Date.now() < switchDeadline) {
    await sleep(250);
    completed = (await request(`/account/switch/${started.body.id}`)).body;
  }
  if (
    completed.status !== "complete" ||
    completed.login !== "desktop-test-user" ||
    completed.models !== 18 ||
    !completed.accountGeneration ||
    completed.accountGeneration === firstAccountGeneration
  ) {
    throw new Error(`Account switch did not complete: ${JSON.stringify(completed)}`);
  }
  if (JSON.stringify(completed).includes("fake-desktop-token")) {
    throw new Error("Completed account API exposed an OAuth token.");
  }

  const account = (await request("/account")).body;
  if (
    account.login !== "desktop-test-user" ||
    account.models !== 18 ||
    account.accountGeneration !== completed.accountGeneration
  ) {
    throw new Error(`Account status is stale: ${JSON.stringify(account)}`);
  }
  const catalog = JSON.parse(fs.readFileSync(path.join(profileHome, "models.json"), "utf8"));
  if (catalog.models.length !== 18) throw new Error("Desktop switch catalog was capped.");
  const desktopCatalog = JSON.parse(
    fs.readFileSync(path.join(profileHome, "models-desktop.json"), "utf8"),
  );
  if (desktopCatalog.models.length < catalog.models.length) {
    throw new Error("Desktop switch did not publish its own complete model catalog.");
  }
  if (!fs.existsSync(path.join(profileHome, "catalog-generation.json"))) {
    throw new Error("Desktop switch did not publish a catalog generation.");
  }
  if (!fs.existsSync(path.join(profileHome, "account-generation.json"))) {
    throw new Error("Account switch did not publish a shared account generation.");
  }
  if (!fs.existsSync(path.join(profileHome, "github-auth.json"))) {
    throw new Error("Validated account switch did not persist the shared credential.");
  }
  const finalPid = (await fetch(`${endpoint}/health`).then((res) => res.json())).pid;
  if (finalPid !== initialPid) {
    throw new Error("CLI and Desktop account switches restarted or replaced the shared bridge.");
  }

  const cancellable = await request("/account/switch", { method: "POST" });
  const cancelled = await request(`/account/switch/${cancellable.body.id}/cancel`, {
    method: "POST",
  });
  if (!["pending", "cancelled"].includes(cancelled.body.status)) {
    throw new Error(`Unexpected cancel response: ${JSON.stringify(cancelled.body)}`);
  }
  let cancelledState = cancelled.body;
  for (let attempt = 0; attempt < 20 && cancelledState.status !== "cancelled"; attempt += 1) {
    await sleep(100);
    cancelledState = (await request(`/account/switch/${cancellable.body.id}`)).body;
  }
  if (cancelledState.status !== "cancelled") {
    throw new Error(`Device flow did not cancel: ${JSON.stringify(cancelledState)}`);
  }

  process.stdout.write("Desktop account API test passed.\n");
} finally {
  bridge.kill();
  await new Promise((resolve) => {
    if (bridge.exitCode !== null) resolve();
    else bridge.once("exit", resolve);
  });
  await new Promise((resolve) => mock.close(resolve));
}
