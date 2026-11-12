"use strict";

function localShellCommand(command) {
  if (/^\/usage(?: --json)?$/.test(command || "")) {
    return "!ccodex usage" + (command.endsWith("--json") ? " --json" : "");
  }
  if (!/^\/sessions(?:\s|$)/.test(command || "")) return null;
  const args = [];
  const text = command.slice("/sessions".length).trim();
  let offset = 0;
  while (offset < text.length) {
    const part = /^(?:"([^"]*)"|([^\s"]+))(?:\s+|$)/.exec(text.slice(offset));
    // Never interpolate shell operators or expansion syntax into a native ! command.
    if (!part) return "!ccodex sessions invalid-arguments";
    const value = part[1] ?? part[2];
    if (!/^[\p{L}\p{N} _./\\:,\-]+$/u.test(value)) return "!ccodex sessions invalid-arguments";
    args.push(/\s/.test(value) ? `"${value}"` : value);
    offset += part[0].length;
  }
  return "!ccodex sessions" + (args.length ? " " + args.join(" ") : "");
}

module.exports = { localShellCommand };
