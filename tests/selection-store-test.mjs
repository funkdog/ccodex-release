import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-selection-store-"));
process.env.CODEX_COPILOT_HOME = home;
const root = path.resolve(import.meta.dirname, "..");
const store = await import(
  `${pathToFileURL(path.join(root, "bridge", "selection-store.mjs")).href}?test=${Date.now()}`
);

test("selection generations change only when effective state changes", () => {
  const first = store.publishSelectionSnapshot({
    model: "gpt-test",
    effort: "high",
    contextTier: "default",
    contextWindow: 400_000,
  }, { updatedBy: "cli" });
  const same = store.publishSelectionSnapshot({
    model: "gpt-test",
    effort: "high",
    contextTier: "default",
    contextWindow: 400_000,
  }, { updatedBy: "desktop" });
  assert.equal(first.snapshot.generation, same.snapshot.generation);
  assert.equal(same.snapshot.updatedBy, "cli");

  const changed = store.publishSelectionSnapshot({
    model: "gpt-test",
    effort: "max",
    contextTier: "long_context",
    contextWindow: 1_050_000,
  }, { updatedBy: "desktop" });
  assert.notEqual(changed.snapshot.generation, same.snapshot.generation);
  assert.equal(changed.snapshot.updatedBy, "desktop");
  assert.deepEqual(store.readSelectionSnapshot(), changed.snapshot);
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
