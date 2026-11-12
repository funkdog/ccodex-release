import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("published Work IQ documentation contains generic usage, not live enterprise test descriptions", () => {
  const file = path.resolve(import.meta.dirname, "../WORKIQ.md");
  const text = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(text, /\u672c\u673a\u8bc1\u636e|\u622a\u56fe\u786e\u8ba4|\u73b0\u573a\u6d4b\u8bd5/);
  assert.doesNotMatch(text, /20\d\d-\d\d-\d\d.{0,30}\u6837\u672c/);
  assert.doesNotMatch(text, /\u5df2(?:\u8bfb\u53d6|\u9a8c\u8bc1).{0,25}\u771f\u5b9e(?:\u90ae\u4ef6|\u4f1a\u8bae|\u8f6c\u5f55)/);
  assert.ok(text.includes("ccodex workiq login"));
  assert.ok(text.includes("ccodex workiq enable --acknowledge-data-sharing"));
  assert.ok(text.includes("ccodex workiq actions approve"));
});
