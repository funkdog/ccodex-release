import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { HistoryError, HistoryManager, parseSessionKey } from "./manager.mjs";
import { codexBackend, copilotBackend } from "./backends.mjs";
import { startHistoryServer } from "./server.mjs";

export function parseHistoryArguments(argv) {
  const args = [...argv];
  if (args[0]?.toLowerCase() === "history") args.shift();
  const command = args.shift() || "help";
  const options = { ids: [] };
  const booleans = new Set(["json", "archived", "not-archived", "open"]);
  const values = new Set(["product", "query", "cwd", "before", "after", "cursor", "limit",
    "operation", "id", "name-template", "out", "plan", "confirm", "port",
    "copilot-home", "ccodex-home", "ccodex-core", "sdk"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      if (command === "preview" && !options.operation) options.operation = arg;
      else throw new HistoryError("invalid_arguments", `Unexpected history argument: ${arg}`);
      continue;
    }
    const name = arg.slice(2);
    if (booleans.has(name)) {
      options[name] = true;
      continue;
    }
    if (!values.has(name) || args[index + 1] === undefined || args[index + 1].startsWith("--")) {
      throw new HistoryError("invalid_arguments", `Unsupported or incomplete history option: ${arg}`);
    }
    const value = args[++index];
    if (name === "id") options.ids.push(value);
    else {
      if (options[name] !== undefined) throw new HistoryError("invalid_arguments", `History option must not be repeated: ${arg}`);
      options[name] = value;
    }
  }
  if (options.archived && options["not-archived"]) {
    throw new HistoryError("invalid_arguments", "Choose either archived or not-archived.");
  }
  return { command, options };
}

export async function resolveCodexCore(home) {
  const local = process.env.LOCALAPPDATA;
  const roots = [
    process.env.CODEX_COPILOT_INSTALL_ROOT,
    local && path.join(local, "CodexCopilot"),
    process.platform !== "win32" && path.join(process.env.XDG_DATA_HOME
      || path.join(os.homedir(), ".local", "share"), "codex-copilot"),
    process.platform !== "win32" && "/opt/codex-copilot",
  ].filter(Boolean);
  for (const root of roots) {
    const selector = path.join(root, "bridge", "cli-update.mjs");
    if (fs.existsSync(selector)) {
      const { cliCoreSelection } = await import(pathToFileURL(selector).href);
      return cliCoreSelection({ root, home }).core;
    }
    const pointer = path.join(root, "bin", "core-current.txt");
    if (fs.existsSync(pointer)) {
      const core = fs.readFileSync(pointer, "utf8").trim();
      if (core && fs.existsSync(core) && fs.lstatSync(core).isFile()) return core;
      throw new HistoryError("core_selection_invalid", "The selected ccodex core is invalid; an older or stock executable is never substituted.");
    }
    const core = path.join(root, "bin", process.platform === "win32" ? "codex-copilot-core.exe" : "codex-copilot-core");
    if (fs.existsSync(core)) return core;
  }
  throw new HistoryError("core_unavailable", "The installed ccodex core is unavailable. Set --ccodex-core to its existing executable; the stock Codex command is never a fallback.");
}

export function defaultHomes(options = {}) {
  return {
    copilot: options["copilot-home"] || process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"),
    ccodex: options["ccodex-home"] || process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot"),
  };
}

async function createManager(options, requestedProducts) {
  const homes = defaultHomes(options);
  const backends = {};
  try {
    for (const product of requestedProducts) {
      if (product === "copilot") {
        backends.copilot = await copilotBackend({ home: homes.copilot, sdkPath: options.sdk });
      } else if (product === "ccodex") {
        backends.ccodex = await codexBackend({
          home: homes.ccodex, core: options["ccodex-core"] || await resolveCodexCore(homes.ccodex),
        });
      } else throw new HistoryError("invalid_product", "History product must be copilot or ccodex.");
    }
  } catch (error) {
    const errors = [error];
    for (const backend of Object.values(backends)) {
      try { await backend.close(); } catch (cleanup) { errors.push(cleanup); }
    }
    throw errors.length === 1 ? error : new AggregateError(errors, "History backend initialization and cleanup failed.");
  }
  return { manager: new HistoryManager(backends), backends };
}

function browser(url) {
  const [file, args] = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawn(file, args, { windowsHide: true, stdio: "ignore" });
  child.on("error", error => process.stderr.write(`History UI browser could not open: ${error.message}\n`));
}

const HELP = `Local session history

history list [--product copilot|ccodex|all] [--query TEXT] [--cwd DIR]
             [--before ISO_DATE] [--after ISO_DATE] [--archived|--not-archived]
             [--cursor N] [--limit 1..200] [--json]
history preview delete|archive|unarchive|rename --id product:UUID [--id product:UUID ...]
                [--name-template "{title} - {index}"] --out PLAN.json
history apply --plan PLAN.json --confirm EXACT_PREVIEW_HASH
history ui [--product copilot|ccodex|all] [--port N] [--open]

Previews never mutate sessions. Running sessions, remote histories and unknown
ownership are protected. Deletion uses the official native API, not directory
removal. Unsupported native operations are shown explicitly. The stock Codex
profile and all credentials are excluded.
Each apply attempt is single-use; PLAN.json.applied records its per-session
results. After a partial failure, create a new preview rather than replaying it.
`;

export async function runHistory(argv, {
  output = value => process.stdout.write(value), managerFactory = createManager,
} = {}) {
  const { command, options } = parseHistoryArguments(argv);
  if (["help", "--help", "-h"].includes(command)) {
    output(HELP);
    return;
  }
  if (!["list", "preview", "apply", "ui"].includes(command)) {
    throw new HistoryError("invalid_command", "Use history list, preview, apply or ui.");
  }
  const common = ["ids", "product", "copilot-home", "ccodex-home", "ccodex-core", "sdk"];
  const allowed = {
    list: ["query", "cwd", "before", "after", "cursor", "limit", "archived", "not-archived", "json"],
    preview: ["operation", "name-template", "out"],
    apply: ["plan", "confirm"],
    ui: ["port", "open"],
  };
  for (const name of Object.keys(options)) {
    if (!common.includes(name) && !allowed[command].includes(name)) {
      throw new HistoryError("invalid_arguments", `History ${command} does not accept --${name}.`);
    }
  }
  if (command !== "preview" && options.ids.length) {
    throw new HistoryError("invalid_arguments", "--id is only used to create an explicit history preview.");
  }
  let plan;
  let planFile;
  if (command === "apply") {
    if (!options.plan || !options.confirm) {
      throw new HistoryError("confirmation_required", "History apply requires the exact saved preview and its confirmation hash.");
    }
    planFile = path.resolve(options.plan);
    const stat = fs.lstatSync(planFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      throw new HistoryError("invalid_plan", "The preview must be a bounded regular JSON file.");
    }
    plan = JSON.parse(fs.readFileSync(planFile, "utf8").replace(/^\uFEFF/, ""));
    new HistoryManager({}).validatePlan(plan, options.confirm);
  }
  const product = options.product || process.env.HISTORY_DEFAULT_PRODUCT || "copilot";
  if (!["all", "copilot", "ccodex"].includes(product)) {
    throw new HistoryError("invalid_product", "Product must be copilot, ccodex or all.");
  }
  const products = command === "preview"
    ? [...new Set(options.ids.map(id => parseSessionKey(id).product))]
    : command === "apply" ? [...new Set((plan.entries || []).map(entry => parseSessionKey(entry.key).product))]
    : product === "all" ? ["copilot", "ccodex"] : [product];
  if (options.product && product !== "all" && products.some(source => source !== product)) {
    throw new HistoryError("product_selection_mismatch", "The explicit session IDs do not match --product.");
  }
  const { manager, backends } = await managerFactory(options, products);
  let listener;
  const failures = [];
  try {
    if (command === "list") {
      const result = await manager.list({
        product, query: options.query || "", cwd: options.cwd || "",
        before: options.before, after: options.after,
        cursor: options.cursor === undefined ? 0 : Number(options.cursor),
        limit: options.limit === undefined ? 50 : Number(options.limit),
        ...(options.archived ? { archived: true } : options["not-archived"] ? { archived: false } : {}),
      });
      if (options.json) output(JSON.stringify(result, null, 2) + "\n");
      else {
        output("SESSION\tMODIFIED\tSTATE\tTITLE\n");
        for (const row of result.sessions) {
          output(`${row.key}\t${row.modifiedAt || "unknown"}\t${row.inUse === false ? "idle" : "protected"}\t${row.title.replace(/[\r\n\t]/g, " ")}\n`);
        }
        output(`Total: ${result.total}; next cursor: ${result.nextCursor ?? "none"}\n`);
      }
    } else if (command === "preview") {
      if (!options.out) throw new HistoryError("preview_path_required", "Save an exact preview with --out before applying.");
      const preview = await manager.plan({
        operation: options.operation, keys: options.ids, nameTemplate: options["name-template"],
      });
      fs.writeFileSync(path.resolve(options.out), JSON.stringify(preview, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      output(JSON.stringify(preview, null, 2) + "\n");
    } else if (command === "apply") {
      let receipt;
      try { receipt = fs.openSync(planFile + ".applied", "wx", 0o600); }
      catch (error) {
        if (error.code === "EEXIST") throw new HistoryError("plan_consumed",
          "This history preview has already been claimed. Read its .applied receipt and create a fresh preview.");
        throw error;
      }
      try {
        const attempted = { planId: plan.id, confirmation: plan.confirmation, status: "started" };
        fs.writeSync(receipt, JSON.stringify(attempted, null, 2) + "\n");
        const result = await manager.apply(plan, options.confirm);
        fs.ftruncateSync(receipt, 0);
        fs.writeSync(receipt, JSON.stringify({ ...attempted, status: "finished", ...result }, null, 2) + "\n", 0, "utf8");
        output(JSON.stringify(result, null, 2) + "\n");
        if (!result.complete) throw new HistoryError("batch_partially_failed", "One or more native history operations failed. Per-session results are shown above.");
      } finally { fs.closeSync(receipt); }
    } else {
      listener = await startHistoryServer(manager, { port: options.port === undefined ? 0 : Number(options.port) });
      output(`Local session history UI: ${listener.url}\nKeep this process open; Ctrl+C shuts down only this history interface.\n`);
      if (options.open) browser(listener.url);
      await new Promise(resolve => {
        const done = () => { process.off("SIGINT", done); process.off("SIGTERM", done); resolve(); };
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
      });
    }
  } catch (error) { failures.push(error); }
  finally {
    if (listener) {
      try { await listener.close(); } catch (error) { failures.push(error); }
    }
    for (const backend of Object.values(backends)) {
      try { await backend.close(); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw failures.length === 1 ? failures[0]
    : new AggregateError(failures, "History operation and owned-runtime cleanup failed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runHistory(process.argv.slice(2)).catch(error => {
    process.stderr.write(`History management failed (${error.code || "error"}): ${error.message}\n`);
    if (error instanceof AggregateError) {
      for (const detail of error.errors) process.stderr.write(`  ${detail.code || "error"}: ${detail.message}\n`);
    }
    process.exitCode = 1;
  });
}
