import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { decodeWindowsInputPrefix } = require("../bin/ccodex-smart-paste.cjs");

function windowsRecord(value) {
  if (typeof value === "object") {
    const { virtualKey, unicode, repeat = 1 } = value;
    return `\x1b[${virtualKey};0;${unicode};1;0;${repeat}_`;
  }
  const code = value.codePointAt(0);
  return `\x1b[${code};0;${code};1;0;1_`;
}

test("smart-paste proxy restores SGR mouse input from Windows ConPTY key records", () => {
  const mouse = "\x1b[<0;7;21M\x1b[<0;7;21m";
  const encoded = [...mouse].map(windowsRecord).join("");
  const decoded = decodeWindowsInputPrefix(encoded);
  assert.equal(decoded.pending, "");
  assert.equal(decoded.events.join(""), mouse);
});

test("smart-paste proxy preserves incomplete records and recognized raw mouse packets", () => {
  assert.deepEqual(decodeWindowsInputPrefix("\x1b[27;0;"), {
    raw: "",
    events: [],
    pending: "\x1b[27;0;",
  });
  assert.deepEqual(decodeWindowsInputPrefix("\x1b[<0;7;21M"), {
    raw: "\x1b[<0;7;21M",
    events: ["\x1b[<0;7;21M"],
    pending: "",
  });
  assert.equal(decodeWindowsInputPrefix("\x1b[31m"), null);
});

test("smart-paste proxy normalizes coalesced destructive key repeats", () => {
  const backspace = windowsRecord({ virtualKey: 8, unicode: 8, repeat: 3 });
  const deletion = windowsRecord({ virtualKey: 46, unicode: 0, repeat: 4 });

  assert.deepEqual(decodeWindowsInputPrefix(backspace).events, ["\x7f"]);
  assert.deepEqual(decodeWindowsInputPrefix(deletion).events, ["\x1b[3~"]);
});
