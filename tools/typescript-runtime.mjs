// Once per Node module graph, including direct targeted test imports. Keep pure
// UI modules importable in an ordinary browser: they have no filesystem gate.
if (typeof process !== "undefined" && typeof process.getBuiltinModule === "function" && import.meta.url.startsWith("file:")) {
  const { fileURLToPath } = process.getBuiltinModule("node:url");
  const { assertTypeScriptBuild } = await import("./typescript-state.mjs");
  assertTypeScriptBuild(fileURLToPath(new URL("../", import.meta.url)));
}
