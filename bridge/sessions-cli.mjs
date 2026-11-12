import { createSessionApi } from "./session-management-api.mjs";
import { HistoryError } from "../tools/history/manager.mjs";

const HELP = `Local bulk session management (Desktop and CLI share the same history)

/sessions list [--query TEXT] [--cwd DIR] [--archived|--active] [--limit 1..200] [--json]
/sessions archive --select 1,3-5
/sessions restore --select all
/sessions archive --all --query TEXT
/sessions archive --id UUID [--id UUID ...]
/sessions delete --select 1,3-5
/sessions delete --all --query TEXT
/sessions apply PREVIEW_ID --confirm CODE
/sessions apply DELETE_PREVIEW_ID --confirm CODE --delete-ack "DELETE COUNT PREVIEW_ID"
/sessions results PREVIEW_ID

Run list first to use row numbers. --select all means every displayed row;
--all selects every filtered result (maximum 500), not just the first page.
Archive/restore/delete only create a preview. Apply requires its exact confirmation.
Delete additionally requires the exact --delete-ack phrase printed by its preview.
Archive keeps history and is reversible; delete removes history and cannot be restored.
Active sessions are protected. Descendants must be explicitly selected, never implied.
No model request is made and project working-directory files are not a delete target.
Outside a conversation, use "ccodex sessions ..." without the leading slash.
`;

export function parseSessionsArguments(argv) {
  const args = [...argv];
  const command = (args[0]?.startsWith("--") ? "list" : args.shift()) || "list";
  if (["help", "--help", "-h"].includes(command)) return { command: "help", args: {} };
  if (!["list", "archive", "restore", "unarchive", "delete", "apply", "results"].includes(command)) {
    throw new HistoryError("invalid_command", "Use /sessions list, archive, restore, delete, apply or results.");
  }
  const request = {};
  const booleans = new Set(["json", "archived", "active", "all"]);
  const values = new Set(["query", "cwd", "cursor", "limit", "select", "id", "confirm", "delete-ack"]);
  let json = false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (!arg.startsWith("--")) {
      if (["apply", "results"].includes(command) && !request.planId &&
          /^(?:[a-f0-9]{8}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(arg)) {
        request.planId = arg.toLowerCase();
        continue;
      }
      throw new HistoryError("invalid_arguments", "Unexpected session-management argument.");
    }
    const name = arg.slice(2);
    if (booleans.has(name)) {
      if (name === "json") json = true;
      else if (name === "all") request.all = true;
      else {
        if (request.archived !== undefined) throw new HistoryError("invalid_filter", "Choose archived or active.");
        request.archived = name === "archived";
      }
      continue;
    }
    if (!values.has(name) || !args[at + 1] || args[at + 1].startsWith("--")) {
      throw new HistoryError("invalid_arguments", "Unsupported or incomplete session-management option.");
    }
    const value = args[++at];
    const property = ({ select: "selection", confirm: "confirmation",
      "delete-ack": "deletionAcknowledgement" })[name] || name;
    if (name === "id") {
      const id = value.replace(/^ccodex:/i, "");
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) {
        throw new HistoryError("invalid_session", "Select sessions by full UUID.");
      }
      (request.keys ||= []).push("ccodex:" + id.toLowerCase());
    } else {
      if (Object.hasOwn(request, property)) throw new HistoryError("invalid_arguments", "Do not repeat session-management options.");
      request[property] = ["limit", "cursor"].includes(name) ? Number(value) : value;
    }
  }
  const allowed = command === "list" ? ["query", "cwd", "archived", "limit", "cursor"]
    : ["apply", "results"].includes(command) ? ["planId", ...(command === "apply"
      ? ["confirmation", "deletionAcknowledgement"] : [])]
    : ["query", "cwd", "archived", "all", "keys", "selection"];
  if (Object.keys(request).some(key => !allowed.includes(key))) {
    throw new HistoryError("invalid_arguments", `These options are not supported by /sessions ${command}.`);
  }
  if (["apply", "results"].includes(command) && !request.planId) {
    throw new HistoryError("preview_required", "Supply the preview ID shown before applying.");
  }
  if (command === "apply" && !request.confirmation) {
    throw new HistoryError("confirmation_required", "Supply --confirm with the code from the exact preview.");
  }
  if (request.deletionAcknowledgement !== undefined &&
      !/^DELETE (?:[1-9]\d{0,2}|0) [a-f0-9]{8}$/.test(request.deletionAcknowledgement)) {
    throw new HistoryError("deletion_acknowledgement_required",
      "Supply --delete-ack with the exact DELETE count and preview ID phrase.");
  }
  if (["archive", "restore", "unarchive", "delete"].includes(command) &&
      !request.all && !request.keys?.length && !request.selection) {
    throw new HistoryError("invalid_selection", "Select exact IDs, listed row numbers or --all with filters.");
  }
  return { command, args: request, json };
}

const clean = value => String(value || "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runSessions(argv, {
  home, port, api = createSessionApi({ home, port }),
  output = text => process.stdout.write(text), sleep = wait,
  clientId = process.env.CCODEX_SESSION_CLIENT_ID || process.env.WT_SESSION || "standalone",
} = {}) {
  const parsed = parseSessionsArguments(argv);
  if (parsed.command === "help") { output(HELP); return; }
  const args = { ...parsed.args, clientId,
    ...(process.env.CODEX_THREAD_ID ? { currentThreadId: process.env.CODEX_THREAD_ID,
      ownerPid: Number(process.env.CCODEX_SESSION_OWNER_PID) } : {}) };
  const print = value => output(JSON.stringify(value, null, 2) + "\n");
  if (parsed.command === "list") {
    const result = await api("list", args);
    if (parsed.json) { print(result); return; }
    output("ROW  STATE      SESSION                                   TITLE\n");
    result.sessions.forEach((row, at) => {
      const state = row.inUse === false ? row.archived ? "archived" : "idle" : "protected";
      output(`${String(at + 1).padEnd(5)}${state.padEnd(11)}${row.id}  ${clean(row.title).slice(0, 100) || "(untitled)"}\n`);
    });
    output(`Total: ${result.total}; displayed: ${result.sessions.length}; next cursor: ${result.nextCursor ?? "none"}\n`);
    output("Preview: /sessions archive --select 1,3-5  |  /sessions restore --select all  |  /sessions delete --select 1,3-5\n");
    output("Protected sessions will be skipped. /sessions help shows filters and select-all options.\n");
    return;
  }
  if (["archive", "restore", "unarchive", "delete"].includes(parsed.command)) {
    const operation = parsed.command === "delete" ? "delete"
      : parsed.command === "archive" ? "archive" : "unarchive";
    const plan = await api("preview", { ...args, operation });
    if (parsed.json) { print(plan); return; }
    output(`Preview ${plan.id.slice(0, 8)}: ${operation} (${plan.entries.length} selected)\n`);
    for (const entry of plan.entries) {
      output(`${entry.eligible ? "READY" : "SKIP "}  ${entry.key.slice(7)}  ${clean(entry.title) || "(untitled)"}${entry.reason ? ` [${entry.reason}]` : ""}\n`);
    }
    if (operation === "delete") {
      output("PERMANENT DELETE: history will be removed, not archived. Restore cannot undo this.\n");
      output("Only the exact READY IDs are targets; unselected or protected descendants are never cascaded.\n");
    }
    output("No sessions changed. Check the exact titles above before confirming.\n");
    if (plan.entries.some(entry => entry.eligible)) {
      output(`/sessions apply ${plan.id.slice(0, 8)} --confirm ${plan.confirmation}` +
        (operation === "delete" ? ` --delete-ack "${plan.deletionAcknowledgement}"` : "") + "\n");
    } else output("No eligible sessions in this selection.\n");
    return;
  }
  let planId = args.planId;
  if (parsed.command === "apply") {
    const result = await api("apply", args);
    planId = result.planId;
  }
  let progress;
  let last = -1;
  do {
    progress = await api("progress", { clientId, planId });
    if (!parsed.json && progress.completed !== last && !progress.done) {
      output(`Processed ${progress.completed}/${progress.total} sessions...\n`);
      last = progress.completed;
    }
    if (!progress.done) await sleep(500);
  } while (!progress.done);
  if (parsed.json) print(progress);
  else {
    for (const result of progress.results) {
      output(`${result.key.slice(7)}  ${result.status}${result.message ? ": " + clean(result.message) : result.reason ? ": " + result.reason : ""}\n`);
    }
    const count = state => progress.results.filter(result => result.status === state).length;
    output(`Complete: ${count("complete")}; skipped: ${count("skipped")}; failed: ${count("failed")}\n`);
    if (progress.error) output(clean(progress.error) + "\n");
  }
  if (progress.error || progress.results.some(result => result.status === "failed")) {
    throw new HistoryError("batch_partially_failed", "Some sessions failed. Results above show which ones; create a fresh preview to retry.");
  }
}
