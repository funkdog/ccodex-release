import assert from "node:assert/strict";
import test from "node:test";
import {
  LINUX_REPOSITORY, LINUX_SIGNING_FINGERPRINT, parseDesktopPackageIndex,
  parseReleaseIndex, repositoryBytes,
} from "../tools/linux-desktop-repository.mjs";

const sha = "a".repeat(64);
const index = `Package: chatgpt
Version: 26.928.40906
Architecture: arm64
Filename: pool/main/c/chatgpt/chatgpt_26.928.40906_arm64.deb
Size: 453477698
SHA256: ${sha}
`;

test("Linux repository trust is pinned to the actual official key fingerprint", () => {
  assert.equal(LINUX_SIGNING_FINGERPRINT, "3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4");
  assert.equal(LINUX_REPOSITORY, "https://persistent.oaistatic.com/codex-app-prod/linux/deb");
});

test("signed release parsing requires one exact bounded SHA256 package index", () => {
  const release = `Suite: stable\nSHA256:\n ${sha} 1651 main/binary-arm64/Packages\nSHA512:\n ignored\n`;
  assert.deepEqual(parseReleaseIndex(release, "main/binary-arm64/Packages"),
    { sha256: sha, size: 1651 });
  assert.throws(() => parseReleaseIndex(release, "main/binary-amd64/Packages"), /one bounded/);
  assert.throws(() => parseReleaseIndex(release.replace("SHA512:", ` ${sha} 1651 main/binary-arm64/Packages\nSHA512:`),
    "main/binary-arm64/Packages"), /one bounded/);
});

test("official package index binds identity, architecture, size, path and digest", () => {
  assert.deepEqual(parseDesktopPackageIndex(index, "arm64"), {
    version: "26.928.40906", architecture: "arm64",
    filename: "pool/main/c/chatgpt/chatgpt_26.928.40906_arm64.deb",
    size: 453477698, sha256: sha,
  });
  assert.throws(() => parseDesktopPackageIndex(index, "x64"), /one official/);
  assert.throws(() => parseDesktopPackageIndex(index + `SHA256: ${sha}\n`, "arm64"), /Duplicate/);
  assert.throws(() => parseDesktopPackageIndex(index.replace("pool/main/c/chatgpt/", "../stock/"), "arm64"), /invalid/);
});

test("repository requests reject replacement paths and redirects before trusting bytes", async () => {
  for (const relative of ["../../stock", "/absolute", "https://evil.invalid/key", "dists/stable/InRelease?redirect=1"]) {
    await assert.rejects(repositoryBytes(relative, {
      request: () => assert.fail("invalid path must not trigger a request"),
    }), /Invalid official repository path/);
  }
  let requested;
  const bytes = await repositoryBytes("dists/stable/InRelease", {
    request: async (url, options) => {
      requested = { url, options };
      return { ok: true, headers: new Headers(), body: [Buffer.from("verified later")] };
    },
  });
  assert.equal(bytes.toString(), "verified later");
  assert.equal(requested.options.redirect, "error");
  assert.equal(requested.url, `${LINUX_REPOSITORY}/dists/stable/InRelease`);
});

test("repository metadata cannot exceed its advertised or streamed bound", async () => {
  await assert.rejects(repositoryBytes("dists/stable/InRelease", {
    maximum: 4,
    request: async () => ({ ok: true, headers: new Headers(), body: [Buffer.from("12345")] }),
  }), /exceeded its bound/);
});
