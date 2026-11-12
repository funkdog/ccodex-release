import "../tools/typescript-runtime.mjs";
import path from "node:path";
import { assertTypeScriptBuild } from "../tools/typescript-state.mjs";
import fs from "node:fs";
import { connectGateway, readMessages, writeMessage } from "./ipc.mjs";
import { protocolVersion } from "./protocol.mjs";

assertTypeScriptBuild(path.resolve(import.meta.dirname, ".."));

const args = process.argv.slice(2);
try {
  if (args.includes("--version")) {
    process.stdout.write(`ccodex-gateway ${protocolVersion}\n`);
  } else if (args.includes("--print-startup-config")) {
    process.stdout.write(JSON.stringify({ appServerVersion: protocolVersion,
      configRequirements: { supportsIndependentSpeedModes: false, requirements: null } }) + "\n");
  } else if (args.includes("app-server") && !args.includes("--startup-sign-out")) {
    const file = process.env.CCODEX_GATEWAY_CONNECTION;
    if (!file) throw new Error("Gateway connection file is required.");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error("Invalid gateway connection file.");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const socket = await connectGateway(config, message => writeMessage(process.stdout, message));
    const dispose = readMessages(process.stdin, message => writeMessage(socket, message), () => socket.destroy());
    process.stdin.once("end", () => socket.end());
    socket.once("close", () => { dispose(); process.stdin.pause(); });
    socket.on("error", error => { console.error(`Gateway connection failed: ${error.message}`); process.exitCode = 1; });
  } else throw new Error("Unsupported gateway CLI command; no native CLI fallback was launched.");
} catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); console.error(`Gateway frontend: ${error.message}`); process.exitCode = 1; }
