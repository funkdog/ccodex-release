import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ResponseIdentityStore } from "../bridge/response-identity.mjs";
import { normalizeResponsesStream } from "../bridge/responses-stream.mjs";

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
for (const required of ["--profile", "--model", "--report-directory"]) {
  assert.ok(args.includes(required) && option(required), `Required: ${required}`);
}
const reportDirectory = path.resolve(option("--report-directory"));
const sourceProfile = path.resolve(option("--profile"));
const model = option("--model");
const verifyNormalization = args.includes("--verify-normalization");
const verifyMaterializedRecovery = args.includes("--verify-materialized-recovery");
assert(!verifyMaterializedRecovery || verifyNormalization,
  "Materialized recovery requires --verify-normalization.");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-response-probe-"));
const startedAt = new Date().toISOString();
const report = {
  schemaVersion: 1, startedAt, pid: process.pid, model,
  verifyNormalization,
  verifyMaterializedRecovery,
  syntheticInputOnly: true, toolsRequested: false, realProfileModified: false,
  requests: [],
};
const describeId = id => typeof id === "string" ? {
  prefix: id.slice(0, 16), length: id.length,
  sha256: createHash("sha256").update(id).digest("hex"),
} : null;
fs.mkdirSync(reportDirectory, { recursive: true });
try {
  process.env.CODEX_HOME = home;
  process.env.CODEX_COPILOT_HOME = home;
  const { COPILOT_API, copilotHeaders } = await import(
    pathToFileURL(path.resolve(import.meta.dirname, "../bridge/auth.mjs"))
  );
  // Read only the already authorized account. Never fall back to another account.
  const auth = JSON.parse(fs.readFileSync(path.join(sourceProfile, "github-auth.json"), "utf8"));
  assert.equal(typeof auth.oauth_token, "string", "Saved account token is required");
  const input = [{ role: "user", content: "Reply with exactly STREAM_IDENTITY_PROBE. Do not use tools." }];
  const response = await fetch(`${COPILOT_API}/responses`, {
    method: "POST",
    headers: copilotHeaders(auth.oauth_token, { accept: "text/event-stream" }),
    body: JSON.stringify({ model, stream: true, input, max_output_tokens: 512,
      reasoning: { effort: "low" } }),
    signal: AbortSignal.timeout(90000),
  });
  const request = {
    status: response.status,
    contentType: response.headers.get("content-type"),
    providerRequestId: response.headers.get("x-github-request-id"),
    events: [],
  };
  report.requests.push(request);
  if (!response.ok) {
    request.error = (await response.text()).slice(0, 2000);
    throw new Error(`Provider returned HTTP ${response.status}`);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const rawChunks = [];
  const observed = [];
  const store = new ResponseIdentityStore({
    home, provider: COPILOT_API, account: auth.login || auth.oauth_token,
  });
  const rawStream = async function* () {
    for await (const chunk of response.body) {
      rawChunks.push(Buffer.from(chunk));
      yield chunk;
    }
  };
  const stream = verifyNormalization
    ? normalizeResponsesStream(rawStream(), { identity: store.createSession() })
    : rawStream();
  const completed = [];
  const starts = new Map();
  const recordFrame = frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data);
    observed.push(event);
    request.events.push({
      type: event.type, outputIndex: event.output_index,
      itemType: event.item?.type, phase: event.item?.phase,
      itemId: describeId(event.item?.id), deltaItemId: describeId(event.item_id),
      responseId: describeId(event.response?.id),
      keys: Object.keys(event), itemKeys: event.item ? Object.keys(event.item) : undefined,
      completedOutput: event.response?.output?.map(item => ({
        type: item.type, id: describeId(item.id), keys: Object.keys(item),
      })),
    });
    if (event.type === "response.output_item.added") starts.set(event.output_index, event.item?.id);
    if (event.type === "response.output_item.done") completed.push({
      index: event.output_index, type: event.item?.type,
      startedId: describeId(starts.get(event.output_index)),
      completedId: describeId(event.item?.id),
      identityChanged: starts.get(event.output_index) !== event.item?.id,
    });
  };
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (;;) {
      const separator = /\r?\n\r?\n/.exec(buffer);
      if (!separator) break;
      recordFrame(buffer.slice(0, separator.index));
      buffer = buffer.slice(separator.index + separator[0].length);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) recordFrame(buffer);
  request.items = completed;
  assert.ok(completed.length, "No completed output item was received");
  if (verifyNormalization) {
    for (const event of observed) {
      if (event.item?.id || event.item_id) {
        assert.equal(event.item?.id || event.item_id, starts.get(event.output_index));
      }
    }
    assert.ok(completed.every(item => !item.identityChanged));
    const upstream = Buffer.concat(rawChunks).toString("utf8").split(/\r?\n\r?\n/).flatMap(frame => {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart()).join("\n");
      try { return [JSON.parse(data)]; } catch { return []; }
    });
    const rawStarts = new Map(upstream.filter(event => event.type === "response.output_item.added")
      .map(event => [event.output_index, event.item.id]));
    request.upstreamItems = upstream.filter(event => event.type === "response.output_item.done").map(event => ({
      index: event.output_index, type: event.item.type,
      startedId: describeId(rawStarts.get(event.output_index)), completedId: describeId(event.item.id),
      identityChanged: rawStarts.get(event.output_index) !== event.item.id,
    }));
    const final = observed.findLast(event => event.type === "response.completed")?.response?.output;
    const rawFinal = upstream.findLast(event => event.type === "response.completed")?.response?.output;
    assert.ok(final?.length, "Provider did not complete the synthetic response");
    if (verifyMaterializedRecovery) {
      assert.ok(store.directory.startsWith(home + path.sep));
      fs.rmSync(store.directory, { recursive: true, force: true });
    }
    let recovery;
    const restored = await new ResponseIdentityStore({
      home, provider: COPILOT_API, account: auth.login || auth.oauth_token,
    }).restoreRequest({ input: final }, {
      allowMaterializedRecovery: verifyMaterializedRecovery,
      onRecovery(value) { recovery = value; },
    });
    const expected = verifyMaterializedRecovery
      ? rawFinal.map(({ id, ...item }) => item) : rawFinal;
    assert.deepEqual(restored.input, expected, "All non-identity provider fields must round-trip exactly");
    report.restoresExactProviderItems = !verifyMaterializedRecovery;
    report.preservesExactMaterializedItems = verifyMaterializedRecovery;
    if (verifyMaterializedRecovery) {
      assert.equal(recovery?.items, final.length);
      assert.equal(recovery.importedForeignIdentities, false);
      report.materializedRecovery = recovery;
    }
    const next = await fetch(`${COPILOT_API}/responses`, {
      method: "POST", headers: copilotHeaders(auth.oauth_token),
      body: JSON.stringify({ model, stream: false,
        input: [...input, ...restored.input, {
          role: "user", content: "Reply with exactly STREAM_IDENTITY_FOLLOWUP. Do not use tools.",
        }], max_output_tokens: 512, reasoning: { effort: "low" } }),
      signal: AbortSignal.timeout(90000),
    });
    const followup = { status: next.status, providerRequestId: next.headers.get("x-github-request-id") };
    report.requests.push(followup);
    if (!next.ok) {
      followup.error = (await next.text()).slice(0, 2000);
      throw new Error(`Round-trip provider request returned HTTP ${next.status}`);
    }
    const body = await next.json();
    followup.outputTypes = body.output?.map(item => item.type);
    followup.completed = body.status === "completed";
    assert.ok(body.output?.some(item => item.type === "message"), "No follow-up message was returned");
    report.followupAccepted = true;
  }
  report.completed = true;
  console.log(JSON.stringify({ pid: process.pid, status: response.status, items: completed }, null, 2));
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(home, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.temporaryProfileRemoved = !fs.existsSync(home);
  fs.writeFileSync(path.join(reportDirectory, "provider-identity-probe.json"), JSON.stringify(report, null, 2));
}
