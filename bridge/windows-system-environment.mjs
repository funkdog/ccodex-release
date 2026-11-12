import path from "node:path";

/** System PowerShell must not discover another engine's portable modules. */
export function windowsSystemEnvironment(inherited = process.env) {
  const env = { ...inherited };
  const read = name => {
    const key = Object.keys(env).find(key => key.toUpperCase() === name);
    return key ? env[key] : undefined;
  };
  const systemRoot = read("SYSTEMROOT") || read("WINDIR");
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("The Windows system directory is unavailable.");
  }
  for (const name of Object.keys(env)) {
    if (["PSMODULEPATH", "PSHOME"].includes(name.toUpperCase())) delete env[name];
  }
  env.PSModulePath = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
  return env;
}
