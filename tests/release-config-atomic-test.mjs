import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { atomicWrite } from "../bridge/atomic-file.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-atomic-selection-"));
process.env.CODEX_COPILOT_HOME = home;
const root = path.resolve(import.meta.dirname, "..");
const { use } = await import(pathToFileURL(path.join(root, "bridge", "use-model.mjs")).href);
const file = path.join(home, "config.toml");
const base = 'model_provider = "github-copilot"\nmodel = "test--default-context"\nmodel_reasoning_effort = "low"\n' +
  '[desktop]\nuserOwned = "retained"\n[model_providers.github-copilot]\nbase_url = "http://127.0.0.1:55555"\n' +
  '# destination-owned-marker\n' + "# retained filler\n".repeat(4000);
fs.writeFileSync(file, base);
fs.writeFileSync(path.join(home, "models.json"), JSON.stringify({ models: [{
  slug: "test", display_name: "Test", default_reasoning_level: "low",
  supported_reasoning_levels: [{ effort: "low" }],
  copilot: { base_model: "test", long_context_prompt_tokens: 200000, route: "responses" },
}] }));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test("unchanged model selection does not rewrite the provider configuration", () => {
  use("test", "low", "default");
  const before = fs.statSync(file).mtimeMs;
  use("test", "low", "default");
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert(fs.readFileSync(file, "utf8").includes("# destination-owned-marker"));
});

test("concurrent readers never observe a truncated provider during repeated Context changes", async () => {
  const state = new SharedArrayBuffer(4);
  const flag = new Int32Array(state);
  const worker = new Worker(`
    const fs = require("node:fs");
    const {parentPort,workerData}=require("node:worker_threads");
    const flag=new Int32Array(workerData.state);
    let checked=0;
    parentPort.postMessage({ready:true});
    while(!Atomics.load(flag,0)){
      const text=fs.readFileSync(workerData.file,"utf8");
      if(!text.includes('model_provider = "github-copilot"') ||
         !text.includes("# destination-owned-marker")) {
        parentPort.postMessage({error:"Reader observed truncated provider configuration"});
        process.exit(1);
      }
      checked++;
      if(checked%32===0) Atomics.wait(flag,0,0,1);
    }
    parentPort.postMessage({checked});
  `, { eval: true, workerData: { state, file } });
  const result = new Promise((resolve, reject) => {
    worker.on("error", reject);
    worker.on("message", message => {
      if (message.error) reject(new Error(message.error));
      if (message.checked !== undefined) resolve(message);
    });
  });
  await new Promise(resolve => worker.once("message", resolve));
  try {
    for (let index = 0; index < 100; index++) {
      use("test", "low", index % 2 ? "default" : "long_context");
    }
  } finally { Atomics.store(flag, 0, 1); }
  const report = await result;
  assert(report.checked > 0);
  await worker.terminate();
});

test("atomic configuration publication refuses a newer destination and leaves no temporary files", () => {
  const original = fs.readFileSync(file, "utf8");
  assert.throws(() => atomicWrite(file, "invalid replacement", { expectedContents: "outdated" }), /concurrently/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(fs.readdirSync(home).filter(name => name.startsWith("config.toml.") && name.endsWith(".tmp")).length, 0);
});
