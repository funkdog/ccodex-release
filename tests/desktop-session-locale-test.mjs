import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { buildDesktopSessionLocalePatch, desktopSessionText } from "../bridge/desktop-session-locale.mjs";

test("session controls have clear Chinese names without changing operation semantics", () => {
  assert.equal(desktopSessionText("Select all filtered"), "\u5168\u9009\u7b5b\u9009\u7ed3\u679c");
  assert.equal(desktopSessionText("Clear selection"), "\u6e05\u7a7a\u9009\u62e9");
  assert.equal(desktopSessionText("Archive selected"), "\u5f52\u6863\u6240\u9009");
  assert.equal(desktopSessionText("Restore selected"), "\u6062\u590d\u6240\u9009");
  assert.equal(desktopSessionText("Exact working directory (optional)"),
    "\u7cbe\u786e\u5de5\u4f5c\u76ee\u5f55\uff08\u53ef\u9009\uff09");
});

test("localized counters retain exact cross-page counts and page numbers", () => {
  assert.equal(desktopSessionText("281 selected"), "\u5df2\u9009 281 \u6761");
  assert.equal(desktopSessionText("282 matching / 50 displayed / page 1"),
    "\u5171 282 \u6761 \u00b7 \u672c\u9875 50 \u6761 \u00b7 \u7b2c 1 \u9875");
  assert.match(desktopSessionText("281 eligible sessions selected across all filtered pages. Active sessions were excluded."),
    /281.*\u8de8\u6240\u6709\u9875/);
});

test("preview, protected states and progress are translated without claiming execution", () => {
  assert.equal(desktopSessionText("Spawned / idle"), "\u5b50\u4f1a\u8bdd \u00b7 \u7a7a\u95f2");
  assert.equal(desktopSessionText("In use - protected"), "\u4f7f\u7528\u4e2d \u00b7 \u5df2\u4fdd\u62a4");
  assert.match(desktopSessionText("Review archive: 2 eligible / 3 selected"), /2.*3/);
  assert.match(desktopSessionText("Processed 4 / 10 sessions..."), /4 \/ 10/);
  assert.match(desktopSessionText("No sessions changed. Review the exact IDs and titles before confirming."),
    /\u8fd8\u6ca1\u6709\u4fee\u6539/);
});

test("localization never alters unknown errors, user titles or identity strings", () => {
  for (const value of ["My Session", "ccodex:01234567-1234-1234-1234-012345678901",
    "Native writer lock changed", "C:\\project\\Session"]) {
    assert.equal(desktopSessionText(value), value);
  }
  const source = buildDesktopSessionLocalePatch();
  new vm.Script(source);
  assert.doesNotMatch(source, /\.checked\s*=|\.value\s*=|\.dispose\(\)|location\.reload|\.onclick\s*=/);
  assert.match(source, /\[data-role=rows\] tr td:nth-child\(3\)/);
  assert.doesNotMatch(source, /text\(.*ccs-heading|text\(.*ccs-title/);
  assert.match(source, /:not\(input\)/);
});

test("English labels and dynamic counts can be restored without replacing the manager", () => {
  assert.equal(desktopSessionText("\u5f52\u6863\u6240\u9009", false), "Archive selected");
  assert.equal(desktopSessionText("\u5df2\u9009 281 \u6761", false), "281 selected");
  assert.equal(desktopSessionText("\u5171 282 \u6761 \u00b7 \u672c\u9875 50 \u6761 \u00b7 \u7b2c 1 \u9875", false),
    "282 matching / 50 displayed / page 1");
});

test("locale installation waits for the DOM without replacing a selected controller", () => {
  const context = vm.createContext({
    __codexCopilotSessionsV1: {
      dispose() { assert.fail("Never dispose the user's selected controller"); },
    },
  });
  assert.equal(vm.runInContext(buildDesktopSessionLocalePatch(), context), "unavailable");
});

test("production helper separates read-only snapshots from the original mutation bridge", () => {
  const source = fs.readFileSync(new URL("../bridge/desktop-patch.mjs", import.meta.url), "utf8");
  assert.match(source, /createDesktopSessionApi/);
  assert.match(source, /await sessionRequest\.close\(\)/);
  assert.match(source, /core: path\.join\(binding\.runtime\.resources/);
  assert.match(source, /assertOwned, desktopUpdates, sessionRequest/);
  const reader = fs.readFileSync(new URL("../bridge/desktop-session-reader.mjs", import.meta.url), "utf8");
  assert.match(reader, /nativeWriterLocks: true, databaseOnly: true/);
  assert.match(reader, /if \(operation === "list"\) return reader\.list\(args\)/);
  assert.match(reader, /const result = await api\(operation, args\)/);
});
