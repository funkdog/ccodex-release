import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { configure, DATA_NOTICE, KNOWN_TOOLS, publicStatus, paths } from "./settings.mjs";
import { createIdentity, safeAuthError, safeWorkIqError } from "./auth.mjs";
import { WorkIqUpstream, discoverEndpoint } from "./transport.mjs";
import { installRuntime } from "./setup.mjs";
import { ActionQueue, isReadOnlyTool } from "./actions.mjs";

const HELP = `Work IQ for ccodex CLI and Desktop

  workiq configure                     Add a disabled, shared MCP integration
  workiq install                       Install pinned JS dependencies under the isolated Work IQ profile
  workiq login                         Microsoft authorization-code + PKCE; never opens a window
  workiq login --method device-code    Explicit alternative; no automatic fallback between methods
  workiq enable --acknowledge-data-sharing
                                        Enable the shared MCP server after reviewing the data boundary
  workiq disable                       Disable without deleting credentials or changing stock Codex
  workiq status                        Local status only; a cache file is not proof of access
  workiq doctor                        Check public endpoint metadata without authentication
  workiq auth-status                   Check this profile's credentials silently
  workiq tools --live                   Discover the actual authorized cloud tool catalog
  workiq capabilities                  Show documented capabilities and the last observed tool names
  workiq ask "<question>"              Ask Work IQ; results may enter the model context
  workiq call <tool> --stdin            Read JSON arguments; write/unknown tools queue an approval instead of executing
  workiq actions [list|show <id>]       Review queued actions; does not execute them
  workiq actions approve <id>           User-only interactive review and exact confirmation
  workiq actions reject <id>            Reject a pending action without executing it
  workiq logout                        Remove this integration's selected cached account and disable

configure/enable/login accept --tenant <Entra UUID or domain>.
${DATA_NOTICE}
`;

function option(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  if (!args[at + 1] || args[at + 1].startsWith("--")) throw new Error(`${name} requires a value.`);
  return args[at + 1];
}

async function stdinJson() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 4 * 1024 * 1024) throw new Error("Tool arguments exceeded 4 MiB.");
  }
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Tool arguments must be a JSON object.");
  return value;
}

async function runCommand(args = [], { profile, output = text => process.stdout.write(text), identityFactory = createIdentity } = {}) {
  const command = args[0] || "status";
  const print = value => output(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
  if (["--help", "-h", "help"].includes(command)) { print(HELP); return; }
  if (command === "mcp") {
    const { runStdio } = await import("./server.mjs");
    await runStdio(profile);
    return;
  }
  if (command === "install") {
    await installRuntime(profile);
    print("Work IQ runtime installed. No Microsoft sign-in, enterprise query, or app restart was performed.");
    return;
  }
  if (["configure", "enable", "disable"].includes(command)) {
    const status = configure({
      profile,
      enable: command === "enable",
      acknowledge: args.includes("--acknowledge-data-sharing"),
      tenant: option(args, "--tenant"),
    });
    print(status);
    print("CLI and Desktop use the same profile. Refresh MCP servers or start a new thread to load changes.");
    return;
  }
  if (command === "status") { print(publicStatus(profile)); return; }
  if (command === "actions") {
    const queue = new ActionQueue(profile);
    const operation = args[1] || "list";
    if (operation === "list") { print(queue.list()); return; }
    const id = args[2];
    if (operation === "show") { print(await queue.show(id)); return; }
    if (operation === "reject") { print(await queue.reject(id)); return; }
    if (operation !== "approve") throw new Error("Use workiq actions [list|show|approve|reject].");
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Action approval requires the user's own interactive terminal or Desktop confirmation. Agent shell tools cannot approve pending actions.");
    }
    const action = await queue.show(id);
    print(action);
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await terminal.question(`Type APPROVE ${id} to execute this exact action: `); }
    finally { terminal.close(); }
    if (answer !== `APPROVE ${id}`) throw new Error("Action was not approved; nothing was executed.");
    const identity = await identityFactory(profile);
    const remote = new WorkIqUpstream(identity, profile);
    try {
      await remote.connect();
      const result = await queue.approve(id, action.requestHash, params => remote.callTool(params));
      print(result);
      if (result.status !== "completed") process.exitCode = 1;
    } finally { await remote.close(); }
    return;
  }
  if (command === "capabilities") {
    print({ documented: KNOWN_TOOLS, ...publicStatus(profile), note: "Documentation and tool discovery are not proof of successful enterprise data access." });
    return;
  }
  if (command === "doctor") {
    print({ ...publicStatus(profile), publicDiscovery: await discoverEndpoint(), enterpriseDataAccessVerified: false });
    return;
  }
  if (command === "login") {
    const method = option(args, "--method") || "authorization-code";
    if (!["authorization-code", "device-code"].includes(method)) {
      throw new Error("Use --method authorization-code or --method device-code.");
    }
    if (!fs.existsSync(paths(profile).settings)) configure({ profile, tenant: option(args, "--tenant") });
    else if (option(args, "--tenant")) configure({ profile, tenant: option(args, "--tenant") });
    const identity = await identityFactory(profile);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    let result;
    try {
      result = method === "authorization-code"
        ? await identity.loginWithAuthorizationCode(address => print({
          method: address.method,
          authorizationUri: address.authorizationUri,
          redirectUri: address.redirectUri,
          expiresInSeconds: address.expiresInSeconds,
          note: "Open this Microsoft address yourself when convenient. Keep this process running for the local callback. No browser was opened and no admin-consent flow was requested.",
        }), { signal: controller.signal })
        : await identity.login(code => {
          print({
            method: "device_code",
            verificationUri: code.verificationUri,
            userCode: code.userCode,
            expiresInSeconds: code.expiresIn,
            note: "Complete this sign-in yourself when convenient. No browser was opened. Do not grant tenant-wide admin consent on behalf of others.",
          });
        }, { signal: controller.signal });
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    print(result);
    print("Sign-in alone does not enable model access. Review 'ccodex workiq enable --acknowledge-data-sharing'.");
    return;
  }
  if (command === "auth-status") {
    print(await (await identityFactory(profile)).status());
    return;
  }
  if (command === "logout") {
    const result = await (await identityFactory(profile)).logout();
    configure({ profile, enable: false });
    print(result);
    return;
  }
  if (command === "tools" && !args.includes("--live")) {
    print(publicStatus(profile));
    print("Use --live to discover the actual service tool catalog. This performs no enterprise content query.");
    return;
  }
  if (!["tools", "ask", "call"].includes(command)) throw new Error(`Unknown Work IQ command '${command}'. Run 'ccodex workiq --help'.`);
  if (command !== "tools") {
    if (!publicStatus(profile).enabled) throw new Error(DATA_NOTICE);
  }
  const identity = await identityFactory(profile);
  const remote = new WorkIqUpstream(identity, profile);
  try {
    await remote.connect();
    if (command === "tools") {
      print({ tools: remote.tools, server: remote.client.getServerVersion?.(), instructions: remote.instructions });
      return;
    }
    const name = command === "ask" ? "ask" : args[1];
    if (!name) throw new Error("Specify the tool name.");
    const tool = remote.tools.find(value => value.name === name);
    if (!tool) throw new Error(`The current Work IQ service does not expose '${name}'.`);
    let toolArguments;
    if (command === "ask") {
      if (!args[1] || args[1].startsWith("--")) throw new Error("Provide a quoted question.");
      toolArguments = { question: args[1] };
    } else {
      if (!args.includes("--stdin")) throw new Error("Pass --stdin and provide JSON arguments on stdin; sensitive content must not go into process arguments.");
      toolArguments = await stdinJson();
    }
    if (!isReadOnlyTool(tool)) {
      print(await new ActionQueue(profile).enqueue({ name, arguments: toolArguments }));
      return;
    }
    const result = await remote.callTool({ name, arguments: toolArguments });
    print(result);
    if (result.isError) process.exitCode = 1;
  } finally {
    await remote.close();
  }
}

export async function runWorkIq(args = [], options = {}) {
  try {
    return await runCommand(args, options);
  } catch (error) {
    if (error?.errorCode || error?.code || error?.name === "UnauthorizedError") {
      const safe = safeWorkIqError(error);
      throw new Error(`${safe.code}: ${safe.message}`);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorkIq(process.argv.slice(2)).catch(error => {
    const isAuth = error?.code || error?.errorCode;
    process.stderr.write(`${isAuth ? safeAuthError(error).message : error.message}\n`);
    process.exitCode = 1;
  });
}
