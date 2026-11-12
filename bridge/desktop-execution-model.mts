/** Stable execution/source identity. Display labels never decide routing. */
export function modelExecutionIdentity(value: string | null | undefined) {
  // Only the reserved transport prefix denotes a gateway engine. Official
  // providers can use slashes in their own model names without changing owner.
  const external = value?.startsWith("mycodex/") ?? false;
  const raw = external ? value!.slice("mycodex/".length) : value ?? "", slash = external ? raw.indexOf("/") : -1;
  const engine = slash < 0 ? "" : raw.slice(0, slash), model = slash < 0 ? raw : raw.slice(slash + 1);
  const api = engine ? /^api-([a-f0-9]{12})--/.exec(model) : null;
  return { engine, source: api ? `api:${api[1]}` : !engine ? "native" : engine === "codex-copilot" ? "github-copilot" : engine === "codex-gemini" ? "google-account" : "cli", model };
}
