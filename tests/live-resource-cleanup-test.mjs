import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("keyboard acceptance disposes its owned PTY only after observing native exit without changing input assertions", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "live-keyboard-smoke.cjs"), "utf8");
  const cleanup = source.slice(source.indexOf(".finally(async () =>"));
  assert.match(cleanup, /if \(child && exited\) \{[\s\S]*?child\.kill\(\);/);
  assert.match(cleanup, /if \(child && !exited\) \{\s*report\.forcedCleanup = true;\s*report\.passed = false/);
  assert.match(cleanup, /report\.testProcessExited = !child \|\| exited/);
  assert.match(cleanup, /report\.exitCode !== 0/);
  assert.match(source, /Shift\+Enter must never submit the draft/);
  assert.match(source, /FIRST-LINE\\nSECOND-LINE/);
  assert.match(source, /fallback CSI-u must not submit the draft/);
  assert.match(source, /FALLBACK-FIRST\\nFALLBACK-SECOND/);
});
