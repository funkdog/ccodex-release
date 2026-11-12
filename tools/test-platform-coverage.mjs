import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const WINDOWS_UNIX_SKIPS = Object.freeze([
  "Unix bridge port file cannot be a symlink",
  "validated stage and rollback reject broad/unrecognized roots",
  "Unix deployment swaps verified payload and cleans only owned temporary dirs",
  "Unix deployment restores previous installation on later failure",
  "staged core hash mismatch leaves old installation untouched",
  "staged executable symlinks are rejected without touching their targets",
  "noninteractive Unix setup fails before deployment when Copilot OAuth is unverified",
  "verified OAuth permits no Copilot CLI while Desktop and stock CLI precede bridge/profile",
  "noninteractive setup will not overwrite a pre-existing unrelated command",
]);

const COUNT_NAMES = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];

export function tapCounts(tap) {
  assert.equal(typeof tap, "string", "Test coverage requires actual TAP output.");
  const counts = {};
  for (const name of COUNT_NAMES) {
    const matches = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, "gm"))];
    assert.equal(matches.length, 1, `Missing or repeated TAP summary: ${name}`);
    const value = Number(matches[0][1]);
    assert(Number.isSafeInteger(value) && value >= 0, `Invalid TAP count: ${name}`);
    counts[name] = value;
  }
  assert(counts.tests > 0, "An empty test run cannot establish coverage.");
  assert.equal(counts.tests, counts.pass + counts.fail + counts.cancelled + counts.skipped,
    "TAP summary counts are inconsistent.");
  return counts;
}

export function windowsPlatformCoverage(tap) {
  const counts = tapCounts(tap);
  assert.equal(counts.fail + counts.cancelled + counts.todo, 0,
    "Windows tests failed, were cancelled or contain TODOs.");
  const skippedNames = [...tap.matchAll(/^ok \d+ - (.*?) # SKIP\r?$/gm)].map(match => match[1]);
  assert.equal(counts.skipped, WINDOWS_UNIX_SKIPS.length, "Unexpected Windows platform skip count.");
  assert.deepEqual([...skippedNames].sort(), [...WINDOWS_UNIX_SKIPS].sort(),
    "Only the declared Unix-only tests may be covered by another platform.");
  return { counts, skippedNames };
}

export function completePlatformCoverage(windowsTap, unixTap) {
  const windows = windowsPlatformCoverage(windowsTap);
  const unix = tapCounts(unixTap);
  assert.equal(unix.fail + unix.cancelled + unix.skipped + unix.todo, 0,
    "Actual Unix coverage must pass without skips, cancellations or TODOs.");
  const passedNames = new Set([...unixTap.matchAll(/^ok \d+ - ([^\r\n]+)\r?$/gm)]
    .map(match => match[1]));
  for (const name of windows.skippedNames) {
    assert(passedNames.has(name), `Windows platform skip lacks an actual Unix pass: ${name}`);
  }
  return {
    schemaVersion: 1,
    windows,
    unix: { counts: unix },
    coveredPlatformSkips: windows.skippedNames,
    counts: {
      tests: windows.counts.tests - windows.counts.skipped + unix.tests,
      pass: windows.counts.pass + unix.pass,
      fail: 0, cancelled: 0, skipped: 0, todo: 0,
    },
  };
}

function readTap(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 * 1024,
    "Test coverage requires a bounded, regular TAP artifact.");
  return fs.readFileSync(file, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [windows, unix, ...extra] = process.argv.slice(2);
    assert(windows && !extra.length, "Usage: test-platform-coverage.mjs <windows.tap> [unix.tap]");
    const result = unix ? completePlatformCoverage(readTap(windows), readTap(unix))
      : windowsPlatformCoverage(readTap(windows));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Actual platform coverage rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
