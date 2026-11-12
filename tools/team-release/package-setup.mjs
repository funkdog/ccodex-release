import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const work = import.meta.dirname;
const option = (name, fallback) => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) || fallback;
const stage = path.resolve(option("--stage", path.join(work, "release-stage")));
const output = path.resolve(process.argv[2]);
const zip = path.resolve(option("--zip", path.join(work, "release-payload.zip")));
const node = process.execPath;
if (!process.argv.includes("--reuse-inventory")) {
  throw new Error("Provide an explicitly frozen --stage and --reuse-inventory. "
    + "Live installations and user profiles are not stage preparation inputs.");
}
const verify = spawnSync(node, [path.join(stage, "release", "verify.mjs"),
  "--payload", "--quick"], {
  cwd: work, stdio: "inherit", windowsHide: true, timeout: 1200000,
});
if (verify.error || verify.status !== 0) throw verify.error || new Error("Pre-package feature checks failed.");
const python = path.join(stage, "runtime", "primary", "codex-primary-runtime", "dependencies", "python", "python.exe");
if (!process.argv.includes("--assembled-zip")) {
  const pack = spawnSync(python, [path.join(work, "zip-payload.py"), stage, zip], {
    cwd: work, stdio: "inherit", windowsHide: true, timeout: 1200000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (pack.error || pack.status !== 0) throw pack.error || new Error("ZIP packaging failed.");
}
const zipVerification = spawnSync(python, [path.join(work, "verify-zip.py"), zip, stage], {
  cwd: work, stdio: "inherit", windowsHide: true, timeout: 1200000,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});
if (zipVerification.error || zipVerification.status !== 0) {
  throw zipVerification.error || new Error("Complete compressed payload verification failed.");
}
const hashFile = async file => {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest();
};
const stub = path.resolve(option("--stub", path.join(work, "setup-arm64.exe")));
const script = path.join(work, "setup-bootstrap.ps1");
const stubSize = fs.statSync(stub).size;
const scriptSize = fs.statSync(script).size;
const zipSize = fs.statSync(zip).size;
const footer = Buffer.alloc(112);
footer.write("CCODEX-SFX-V1", 0, "ascii");
footer.writeBigUInt64LE(BigInt(stubSize + scriptSize), 16);
footer.writeBigUInt64LE(BigInt(zipSize), 24);
(await hashFile(zip)).copy(footer, 32);
footer.writeBigUInt64LE(BigInt(stubSize), 64);
footer.writeBigUInt64LE(BigInt(scriptSize), 72);
(await hashFile(script)).copy(footer, 80);
fs.mkdirSync(path.dirname(output), { recursive: true });
const destination = fs.createWriteStream(output);
for (const file of [stub, script, zip]) {
  for await (const chunk of fs.createReadStream(file)) {
    if (!destination.write(chunk)) await new Promise(resolve => destination.once("drain", resolve));
  }
}
destination.end(footer);
await new Promise((resolve, reject) => {
  destination.once("finish", resolve);
  destination.once("error", reject);
});
const hash = (await hashFile(output)).toString("hex");
fs.writeFileSync(`${output}.sha256`, `${hash}  ${path.basename(output)}\n`, "ascii");
console.log(JSON.stringify({
  installer: output, size: fs.statSync(output).size, sha256: hash,
  target: JSON.parse(fs.readFileSync(path.join(stage, "release.json"), "utf8")).target, nativeStubBytes: stubSize,
}, null, 2));
