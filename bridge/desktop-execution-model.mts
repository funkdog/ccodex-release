/** Stable execution/source identity. Display labels never decide routing. */
export function modelExecutionIdentity(value: string | null | undefined) {
  const raw = value?.replace(/^mycodex\//, "") ?? "", slash = raw.indexOf("/");
  const engine = slash < 0 ? "" : raw.slice(0, slash), model = slash < 0 ? raw : raw.slice(slash + 1);
  const api = /^api-([a-f0-9]{12})--/.exec(model);
  return { engine, source: api ? `api:${api[1]}` : !engine ? "native" : engine === "codex-copilot" ? "github-copilot" : engine === "codex-gemini" ? "google-account" : "cli", model };
}
