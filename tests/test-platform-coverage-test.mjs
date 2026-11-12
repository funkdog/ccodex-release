import assert from "node:assert/strict";
import test from "node:test";
import {
  WINDOWS_UNIX_SKIPS, tapCounts, windowsPlatformCoverage, completePlatformCoverage,
} from "../tools/test-platform-coverage.mjs";

function report(names, counts) {
  return "TAP version 13\n" + names.map((name, index) => `ok ${index + 1} - ${name}\n`).join("")
    + Object.entries(counts).map(([name, value]) => `# ${name} ${value}\n`).join("");
}
const windowsCounts = { tests: 239, pass: 230, fail: 0, cancelled: 0, skipped: 9, todo: 0 };
const unixCounts = { tests: 18, pass: 18, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
const windows = report(WINDOWS_UNIX_SKIPS.map(name => `${name} # SKIP`), windowsCounts);
const unix = report([...WINDOWS_UNIX_SKIPS, ...Array.from({ length: 9 }, (_, index) =>
  `Other actual Unix check ${index}`)], unixCounts);

test("actual Unix passes cover exactly the declared Windows platform skips without hiding raw counts", () => {
  const result = completePlatformCoverage(windows, unix);
  assert.deepEqual(result.windows.counts, windowsCounts);
  assert.deepEqual(result.unix.counts, unixCounts);
  assert.deepEqual(result.coveredPlatformSkips, WINDOWS_UNIX_SKIPS);
  assert.deepEqual(result.counts, {
    tests: 248, pass: 248, fail: 0, cancelled: 0, skipped: 0, todo: 0,
  });
  assert.deepEqual(completePlatformCoverage(windows.replaceAll("\n", "\r\n"), unix), result);
});

test("a Windows-only report cannot fabricate aggregate completion", () => {
  const result = windowsPlatformCoverage(windows);
  assert.equal(result.counts.skipped, 9);
  assert.equal(result.coveredPlatformSkips, undefined);
  assert.throws(() => completePlatformCoverage(windows, ""), /summary/);
});

test("missing, repeated and inconsistent summaries are rejected", () => {
  for (const [tap, message] of [
    [unix.replace("# tests 18\n", ""), /summary/],
    [unix + "# tests 18\n", /summary/],
    [unix.replace("# pass 18", "# pass 17"), /inconsistent/],
    [report([], { ...unixCounts, tests: 0, pass: 0 }), /empty/],
  ]) assert.throws(() => tapCounts(tap), message);
});

test("an unexpected skip or duplicated declared skip remains a hard failure", () => {
  for (const tap of [
    windows.replace(WINDOWS_UNIX_SKIPS[0], "Missing native runtime"),
    windows.replace(WINDOWS_UNIX_SKIPS[0], WINDOWS_UNIX_SKIPS[1]),
    windows.replace("# skipped 9", "# skipped 8").replace("# pass 230", "# pass 231"),
  ]) assert.throws(() => windowsPlatformCoverage(tap), /declared|skip/);
});

test("non-passing Windows or Unix results cannot authorize deployment", () => {
  for (const name of ["fail", "cancelled", "todo"]) {
    const failedWindows = { ...windowsCounts, [name]: 1,
      pass: name === "todo" ? windowsCounts.pass : windowsCounts.pass - 1 };
    const failedUnix = { ...unixCounts, [name]: 1,
      pass: name === "todo" ? unixCounts.pass : unixCounts.pass - 1 };
    assert.throws(() => completePlatformCoverage(
      report(WINDOWS_UNIX_SKIPS.map(value => `${value} # SKIP`), failedWindows), unix,
    ), /failed|cancelled|TODO/);
    assert.throws(() => completePlatformCoverage(
      windows, report(WINDOWS_UNIX_SKIPS, failedUnix),
    ), /Unix coverage/);
  }
  assert.throws(() => completePlatformCoverage(windows, report(WINDOWS_UNIX_SKIPS,
    { ...unixCounts, pass: 17, skipped: 1 })), /Unix coverage/);
});

test("counts alone and a skipped Unix name do not prove the missing Windows checks", () => {
  assert.throws(() => completePlatformCoverage(windows,
    report(WINDOWS_UNIX_SKIPS.slice(1), unixCounts)), /lacks an actual Unix pass/);
  assert.throws(() => completePlatformCoverage(windows,
    unix.replace(`${WINDOWS_UNIX_SKIPS[0]}\n`, `${WINDOWS_UNIX_SKIPS[0]} # SKIP\n`)),
  /lacks an actual Unix pass/);
});
