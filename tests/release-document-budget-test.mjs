import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DOCUMENT_CHECK_TIMEOUT_MS, PYTHON_RPC_CHECK_TIMEOUT_MS } from "../release/document-check.mjs";

test("outer document verification reserves time for rendering before its bounded Python child", () => {
  assert.equal(PYTHON_RPC_CHECK_TIMEOUT_MS, 120000);
  assert.equal(DOCUMENT_CHECK_TIMEOUT_MS, 240000);
  assert.ok(DOCUMENT_CHECK_TIMEOUT_MS >= PYTHON_RPC_CHECK_TIMEOUT_MS + 60000);
});

test("installed and payload verification apply the complete document-check budget", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../release/verify.mjs"), "utf8");
  assert.match(source, /import \{ DOCUMENT_CHECK_TIMEOUT_MS \} from "\.\/document-check\.mjs"/);
  assert.match(source, /document-check\.mjs"\), primary, env\.CODEX_HOME,\s*\], env, DOCUMENT_CHECK_TIMEOUT_MS\)/);
});
